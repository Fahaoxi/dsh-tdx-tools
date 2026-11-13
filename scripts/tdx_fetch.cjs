#!/usr/bin/env node
/**
 * tdx_fetch.js —— 通达信 MCP 取数脚本（自带会话自愈）
 *
 * 为什么需要它（诊断见 docs/tdx-mcp-session-diagnosis.md）：
 *   TDX 服务端会空闲回收 MCP session，客户端持有的 id 变成孤儿，
 *   之后所有调用返回 -32000 Session not found or expired。
 *   DSH 的 reconnect 只在连接断开时触发，SDK 也不自动重新握手 ⇒ 表现为「时好时坏」。
 *   本脚本在检测到 -32000 / 404 时自动重新 initialize 并重放，实测可完全消除该故障。
 *
 * 用法：
 *   node tdx_fetch.cjs chain   --month 2611 --underly <code> [--out out.json]
 *   node tdx_fetch.cjs kline   --code <code> --setcode 0 [--count 90]
 *   node tdx_fetch.cjs quote   --code <code> --setcode 0
 *   node tdx_fetch.cjs months  --underly <code>
 *
 * 输出：统一 JSON 到 stdout（或 --out 指定文件）
 *
 * 注意：凭据从 WorkBuddy 的加密存储中读取，不落明文、不回显。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ENDPOINT = 'https://txmcp.tdx.com.cn:3001/txmcp';
const PROTOCOL = '2024-11-05';

// ---------- 凭据 ----------

function decryptAuth() {
  // 凭据优先级：
  // 1. TDX_MCP_TOKEN —— 发布版的唯一方式，用户自备，形如 "TDX-xxxx" 或 "Bearer TDX-xxxx"
  // 2. WorkBuddy 加密存储 —— 仅本机开发期回退，需 TDX_CONNECTOR_UID 显式指定，不硬编码
  const fromEnv = process.env.TDX_MCP_TOKEN;
  if (fromEnv && fromEnv.trim()) {
    const raw = fromEnv.trim();
    return /^Bearer\s/i.test(raw) ? raw : `Bearer ${raw}`;
  }

  const uid = process.env.TDX_CONNECTOR_UID;
  if (!uid) {
    throw new Error(
      '未配置凭据：请设置环境变量 TDX_MCP_TOKEN（自备通达信 MCP token）。' +
        '本机开发期如需复用 WorkBuddy 存储，另设 TDX_CONNECTOR_UID。',
    );
  }
  const dir = path.join(os.homedir(), '.workbuddy', 'connectors', uid);
  const states = JSON.parse(fs.readFileSync(path.join(dir, 'connector-states.json'), 'utf8'));
  const master = fs.readFileSync(path.join(dir, '.master.key'));
  const salt = Buffer.from(states.encryption.salt, 'base64');
  const key = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.concat([master, Buffer.from(uid, 'utf8')]),
      salt,
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

// ---------- 协议 ----------

function parseSSE(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        /* ignore fragment */
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

class TdxClient {
  constructor(auth, { endpoint = ENDPOINT, verbose = false } = {}) {
    this.auth = auth;
    this.endpoint = endpoint;
    this.verbose = verbose;
    this.sid = null;
    this.reinitCount = 0;
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

  async rpc(method, params) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    return { status: res.status, sid: res.headers.get('mcp-session-id'), json: parseSSE(text), raw: text };
  }

  async handshake() {
    this.sid = null;
    const r = await this.rpc('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'cyb-option-signal', version: '0.1.0' },
    });
    if (r.status !== 200 || !r.sid) {
      throw new Error(`initialize 失败: status=${r.status} body=${r.raw.slice(0, 200)}`);
    }
    this.sid = r.sid;
    await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    if (this.verbose) console.error(`[handshake] session ${this.sid.slice(0, 8)}…`);
    return this.sid;
  }

  /** 带会话自愈的调用：失败则重握手并重放一次。 */
  async callTool(name, args) {
    if (!this.sid) await this.handshake();
    let r = await this.rpc('tools/call', { name, arguments: args });
    const expired =
      r.status === 404 ||
      r.status === 400 ||
      (r.json && r.json.error && r.json.error.code === -32000);
    if (expired) {
      this.reinitCount += 1;
      if (this.verbose) console.error('[call] session expired -> re-initialize');
      await this.handshake();
      r = await this.rpc('tools/call', { name, arguments: args });
    }
    if (r.status !== 200) {
      throw new Error(`tools/call ${name} 失败: status=${r.status} body=${r.raw.slice(0, 300)}`);
    }
    if (r.json && r.json.error) {
      throw new Error(`tools/call ${name} 返回错误: ${JSON.stringify(r.json.error).slice(0, 300)}`);
    }
    return r.json;
  }

  async close() {
    if (!this.sid) return;
    try {
      await fetch(this.endpoint, {
        method: 'DELETE',
        headers: this.headers,
        body: '',
      });
    } catch {
      /* best effort */
    }
    this.sid = null;
  }
}

// ---------- 结果提取 ----------

function extractText(json) {
  const content = (json && json.result && json.result.content) || [];
  return content
    .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');
}

/** 从工具返回的文本里取出嵌入的 JSON 对象（tdx 会附一段候选元数据尾巴）。 */
function extractJsonBlock(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 去掉 tdx 附加的 [MCP App候选元数据] 尾巴，只留人类可读摘要。 */
function stripTail(text) {
  const marker = '[MCP App候选元数据]';
  const i = text.indexOf(marker);
  return (i >= 0 ? text.slice(0, i) : text).trim();
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** 证券代码为必填项——不设默认值，避免把某个特定标的写死进通用工具。 */
function requireCode(args) {
  const code = args.code;
  if (!code) throw new Error('缺少 --code <证券代码>');
  return String(code);
}

function writeOutput(obj, outPath) {
  const text = JSON.stringify(obj, null, 2);
  if (outPath) {
    const dir = path.dirname(outPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, text, 'utf8');
    console.error(`[out] ${outPath}`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd) {
    console.error('用法: node tdx_fetch.js <chain|kline|quote|months> [options]');
    process.exit(2);
  }

  const auth = decryptAuth();
  const client = new TdxClient(auth, { verbose: true });
  const fetchedAt = new Date().toISOString();

  try {
    let payload;

    if (cmd === 'months') {
      const underlyMarket = args.underlyMarket || '0';
      const underlyCode = args.underly;
      if (!underlyCode) throw new Error('months 需要 --underly <标的代码>');
      const json = await client.callTool('tdx_option_t_quote', {
        underlyMarket,
        underlyCode,
        wantNum: Number(args.wantNum || 100),
      });
      payload = { kind: 'months', fetchedAt, underlyMarket, underlyCode, text: stripTail(extractText(json)), raw: json };
    } else if (cmd === 'chain') {
      const underlyMarket = args.underlyMarket || '0';
      const underlyCode = args.underly;
      if (!underlyCode) throw new Error('chain 需要 --underly <标的代码>');
      if (!args.month) throw new Error('chain 需要 --month（先用 months 子命令查可选月份）');
      const argv2 = {
        underlyMarket,
        underlyCode,
        month: String(args.month),
        wantNum: Number(args.wantNum || 100),
      };
      if (args.underlyPrice) argv2.underlyPrice = Number(args.underlyPrice);
      const json = await client.callTool('tdx_option_t_quote', argv2);
      const text = stripTail(extractText(json));
      const parsed = extractJsonBlock(text);
      payload = {
        kind: 'chain',
        fetchedAt,
        underlyMarket,
        underlyCode,
        month: String(args.month),
        source: 'tdx-connector',
        textHead: text.split('\n').slice(0, 3).join('\n'),
        tQuoteRows: (parsed && parsed.tQuoteRows) || null,
        months: (parsed && parsed.months) || null,
      };
    } else if (cmd === 'kline') {
      const json = await client.callTool('tdx_kline', {
        code: requireCode(args),
        setcode: String(args.setcode || '0'),
        period: String(args.period || '4'),
        wantNum: Number(args.count || 90),
      });
      const text = stripTail(extractText(json));
      const parsed = extractJsonBlock(text);
      payload = {
        kind: 'kline',
        fetchedAt,
        code: requireCode(args),
        setcode: String(args.setcode || '0'),
        source: 'tdx-connector',
        textHead: text.split('\n').slice(0, 3).join('\n'),
        rows: (parsed && parsed.Rows) || null,
        attach: (parsed && parsed.AttachInfo) || null,
      };
    } else if (cmd === 'quote') {
      const json = await client.callTool('tdx_quotes', {
        code: requireCode(args),
        setcode: String(args.setcode || '0'),
      });
      const text = stripTail(extractText(json));
      const parsed = extractJsonBlock(text);
      payload = { kind: 'quote', fetchedAt, code: requireCode(args), setcode: String(args.setcode || '0'), source: 'tdx-connector', textHead: text.split('\n').slice(0, 2).join('\n'), data: parsed };
    } else {
      throw new Error(`未知子命令: ${cmd}`);
    }

    payload.reinitCount = client.reinitCount;
    writeOutput(payload, args.out);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`[error] ${e.message}`);
  process.exit(1);
});
