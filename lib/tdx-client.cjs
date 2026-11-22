/**
 * tdx-client.cjs — 常驻 MCP 客户端（连接池 + 互斥锁 + 会话自愈）
 *
 * 设计要点：
 *   1. 全局单例：整个 DSH 进程共用一条 MCP 会话，避免每次工具调用重新握手。
 *      实测：复用 session ~170ms/次，每次 spawn 新进程 ~564ms/次。
 *   2. 互斥锁：重握手期间其他调用排队等待，防止拿到失效 sid。
 *   3. 会话自愈：检测 404 / 400 / -32000，重新 initialize 并重放。
 *   4. 懒初始化：首次调用才握手，避免插件加载时就发网络请求。
 *
 * 与 scripts/tdx_fetch.cjs 的关系：
 *   那个文件保留为独立 CLI（fetch_and_run.py 还在用），本文件是插件专用的常驻版本。
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENDPOINT = 'https://txmcp.tdx.com.cn:3001/txmcp';
const PROTOCOL = '2024-11-05';

// ---------- 凭据 ----------

/**
 * 读取 Authorization。优先级：
 *   1. TDX_MCP_TOKEN 环境变量（发布版唯一方式）
 *   2. WorkBuddy 加密存储（本机开发期回退，需 TDX_CONNECTOR_UID）
 */
function readAuth() {
  const raw = process.env.TDX_MCP_TOKEN;
  if (raw && raw.trim()) {
    const t = raw.trim();
    return /^Bearer\s/i.test(t) ? t : `Bearer ${t}`;
  }

  const uid = process.env.TDX_CONNECTOR_UID;
  if (!uid) {
    const err = new Error('未配置 TDX_MCP_TOKEN');
    err.code = 'NO_TOKEN';
    throw err;
  }

  const dir = path.join(os.homedir(), '.workbuddy', 'connectors', uid);
  const states = JSON.parse(fs.readFileSync(path.join(dir, 'connector-states.json'), 'utf8'));
  const master = fs.readFileSync(path.join(dir, '.master.key'));
  const key = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.concat([master, Buffer.from(uid, 'utf8')]),
      Buffer.from(states.encryption.salt, 'base64'),
      Buffer.from('workbuddy-oauth-credentials-v1'),
      32,
    ),
  );
  const env = states.headerOverrides['tdx-connector'].Authorization;
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAAD(Buffer.from(`${uid}|connector-states:headerOverrides:tdx-connector|Authorization`));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8');
}

// ---------- 响应解析 ----------

/** 响应可能是 SSE（data: {...}）或裸 JSON，两种都吃。 */
function parseBody(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        /* 可能是分片，继续找 */
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从工具结果里取出人类可读文本。 */
function extractText(json) {
  const content = (json && json.result && json.result.content) || [];
  return content.map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
}

/** 去掉 tdx 附加的候选元数据尾巴。 */
function stripTail(text) {
  const marker = '[MCP App候选元数据]';
  const i = text.indexOf(marker);
  return (i >= 0 ? text.slice(0, i) : text).trim();
}

// ---------- 错误分类 ----------

function classifyError(status, json, raw) {
  const msg = JSON.stringify(json || raw || '').slice(0, 400);
  if (status === 401 || /quota is below|leftValue/.test(msg)) {
    const m = /"leftValue":\s*(-?\d+)/.exec(msg);
    const e = new Error(
      `通达信 MCP 配额不足${m ? `（剩余 ${m[1]}）` : ''}。到 https://vip.tdx.com.cn 充值后即可恢复。`,
    );
    e.code = 'QUOTA_EXHAUSTED';
    return e;
  }
  if (json && json.error && json.error.code === -32000) {
    const e = new Error('MCP 会话失效且自动重建失败。');
    e.code = 'SESSION_EXPIRED';
    return e;
  }
  const e = new Error(`服务端返回 HTTP ${status}: ${msg}`);
  e.code = 'FETCH_FAILED';
  return e;
}

// ---------- 客户端 ----------

class TdxClient {
  constructor(auth, { endpoint = ENDPOINT } = {}) {
    this.auth = auth;
    this.endpoint = endpoint;
    this.sid = null;
    this.reinitCount = 0;
    this.handshakes = 0;
    /** 正在进行的握手；并发调用共享它，避免重复握手互相踢掉 session。 */
    this._pending = null;
    /**
     * JSON-RPC 请求 id 必须单调递增。
     * 用固定 id 时，并发请求会因 id 重复而永远等不到响应（实测卡死）。
     */
    this._rpcId = 0;
  }

  get headers() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: this.auth,
    };
    if (this.sid) h['Mcp-Session-Id'] = this.sid;
    return h;
  }

  async _post(method, params, withId = true) {
    const body = { jsonrpc: '2.0', method, params };
    // 每条请求独立 id：并发时重复 id 会让服务端无法匹配响应，导致挂起。
    if (withId) body.id = ++this._rpcId;
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sid = sid;
    const text = await res.text();
    return { status: res.status, json: parseBody(text), raw: text };
  }

  /**
   * 建新会话。并发调用共享同一次握手。
   *
   * 关键：不能用「排队各握一次」——N 个并发请求会握手 N 次，
   * 后一次的 sid 覆盖前一次，先重放的请求立刻又失效，形成雪崩。
   * 正确做法：记录正在进行的握手，其他调用直接 await 同一个 Promise。
   */
  async handshake() {
    // 已有握手在跑：直接等它，绝不另起一个。
    if (this._pending) return this._pending;

    const run = async () => {
      this.sid = null;
      const r = await this._post('initialize', {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'dsh-tdx-tools', version: '0.2.0' },
      });
      if (r.status !== 200 || !this.sid) {
        throw classifyError(r.status, r.json, r.raw);
      }
      await this._post('notifications/initialized', {}, false);
      this.handshakes += 1;
      return this.sid;
    };

    // 注意：先赋 _pending 再 await，且 finally 里只在「仍是我自己」时才清空，
    // 否则会把后来者刚建立的新握手引用清掉。
    const p = run();
    this._pending = p;
    try {
      return await p;
    } finally {
      if (this._pending === p) this._pending = null;
    }
  }

  /** 调用工具；会话失效则重建并重放一次。 */
  async callTool(name, args) {
    if (!this.sid) await this.handshake();

    const attempt = () => this._post('tools/call', { name, arguments: args });

    let r = await attempt();
    const expired =
      r.status === 404 ||
      r.status === 400 ||
      (r.json && r.json.error && r.json.error.code === -32000);

    if (expired) {
      // 此刻可能已有别的调用完成了握手：sid 变了就直接重放，不重复握手。
      const staleSid = this.sid;
      this.reinitCount += 1;
      await this.handshake();
      if (this.sid === staleSid) {
        throw classifyError(r.status, r.json, r.raw);
      }
      r = await attempt();
    }

    if (r.status !== 200 || (r.json && r.json.error)) {
      throw classifyError(r.status, r.json, r.raw);
    }
    return r.json;
  }

  /** 主动结束会话（DSH 关闭时调用）。 */
  async close() {
    if (!this.sid) return;
    try {
      await fetch(this.endpoint, { method: 'DELETE', headers: this.headers, body: '' });
    } catch {
      /* best effort */
    }
    this.sid = null;
  }
}

// ---------- 全局单例 ----------

let singleton = null;

/**
 * 取得共享客户端。首次调用才握手（懒初始化）。
 * 凭证错误会立即抛出，不会静默降级。
 */
async function getClient() {
  if (!singleton) {
    const auth = readAuth();
    singleton = new TdxClient(auth);
  }
  if (!singleton.sid) await singleton.handshake();
  return singleton;
}

/** 观测用：当前会话统计。 */
function stats() {
  if (!singleton) return { ready: false, handshakes: 0, reinitCount: 0 };
  return {
    ready: Boolean(singleton.sid),
    handshakes: singleton.handshakes,
    reinitCount: singleton.reinitCount,
  };
}

async function closeClient() {
  if (!singleton) return;
  const c = singleton;
  singleton = null;
  await c.close();
}

module.exports = {
  TdxClient,
  getClient,
  closeClient,
  stats,
  readAuth,
  parseBody,
  extractText,
  stripTail,
  classifyError,
  ENDPOINT,
};
