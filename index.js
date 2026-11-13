/**
 * dsh-tdx-tools — 把本项目的通达信取数能力注册为 DSH 工具。
 *
 * 为什么是薄壳：
 *   真正的取数逻辑（MCP 握手、会话自愈、SSE 解析、文本抠 JSON）已经在
 *   scripts/tdx_fetch.js 里验证过，这里只做进程调用 + 结果整形，不重复实现。
 *   计算仍留在 Python engine/*，插件不碰。
 *
 * 契约（照 dsh-ops 的写法）：
 *   cordis.patch.yml insert 一行 {id, name:'dsh-tdx-tools'}
 *   → loader 加载本包 main，调用 apply(ctx, config)
 *   → inject=['tools']，通过 ctx.tools.register 注册 4 个工具
 *
 * 与 MCP 桥接（@deepseek-ai/dsh-mcp-client）的区别：
 *   MCP 桥把 tdx 的 20 个工具原样暴露给模型，但会话失效时 SDK 不会自动重建；
 *   本插件走 tdx_fetch.js，自带「-32000 → 重新 initialize → 重放」自愈。
 */

export const name = 'dsh-tdx-tools';

/** 需要 tools 服务才能注册工具。 */
export const inject = ['tools'];

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包根目录（ESM 下可靠）。 */
const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * 项目根目录：仅供本机开发期覆盖。
 * 发布版默认用包内 scripts/tdx_fetch.js，不依赖任何外部目录。
 */
const DEFAULT_PROJECT_ROOT = resolve(ROOT, '..', '..');

/** 包内自带的取数脚本——发布版默认走这条，装完即用。
 *  用 .cjs：本包是 "type": "module"，取数脚本是 CommonJS，扩展名必须区分。 */
const VENDORED_SCRIPT = join(ROOT, 'scripts', 'tdx_fetch.cjs');

/** Node 候选：只用 PATH 里的 node，不硬编码任何机器路径。 */
const NODE_CANDIDATES = ['node'];

/** 单次取数超时。MCP 端点冷启动 + 重握手最坏约 20s，留足余量。 */
const FETCH_TIMEOUT_MS = 90_000;

function findNode() {
  // DSH 自身就跑在 Node 上：优先复用当前解释器，避免 PATH 里没有 node 时取数失败。
  if (process.execPath && existsSync(process.execPath)) return process.execPath;
  for (const cand of NODE_CANDIDATES) {
    if (cand === 'node' || existsSync(cand)) return cand;
  }
  return 'node';
}

/**
 * 调用 tdx_fetch.js，返回解析后的 JSON 与取数元信息。
 *
 * tdx_fetch.js 把数据写 stdout、诊断写 stderr（[handshake] / [out]），
 * 所以 stdout 必须是纯 JSON；解析失败按取数失败处理，绝不返回半截数据。
 */
function runFetch(scriptPath, argv) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(findNode(), [scriptPath, ...argv], {
        cwd: dirname(dirname(scriptPath)),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolvePromise({ ok: false, code: 'SPAWN_FAILED', message: String(error?.message ?? error) });
      return;
    }

    const out = [];
    const err = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      finish({ ok: false, code: 'TIMEOUT', message: `取数超时（${FETCH_TIMEOUT_MS}ms）` });
    }, FETCH_TIMEOUT_MS);

    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (error) => finish({ ok: false, code: 'SPAWN_FAILED', message: String(error?.message ?? error) }));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        finish({
          ok: false,
          code: 'FETCH_FAILED',
          message: (stderr.trim().split('\n').pop() || `退出码 ${code}`).slice(0, 400),
        });
        return;
      }
      try {
        finish({ ok: true, data: JSON.parse(stdout), stderr });
      } catch (error) {
        finish({ ok: false, code: 'BAD_JSON', message: `stdout 不是合法 JSON：${String(error?.message ?? error)}` });
      }
    });
  });
}

/** 取数失败统一渲染成模型可读的诊断，绝不伪造数据。 */
function renderFailure(kind, failure) {
  return [
    `[取数失败] ${kind}`,
    `code: ${failure.code}`,
    `detail: ${failure.message}`,
    '',
    '可能原因：MCP 端点不可达 / 凭据失效 / 配额耗尽（401 + leftValue 表示配额不足）。',
    '这不是空数据——是没取到数据。不要据此推断行情。',
  ].join('\n');
}

/**
 * 注册工具定义。
 * 每个工具都返回 { ok, kind, ... } 结构；render 负责转成模型可读文本。
 */
export function apply(ctx, config = {}) {
  const scriptPath = config.scriptPath
    ? resolve(String(config.scriptPath))
    : config.projectRoot
      ? join(resolve(String(config.projectRoot)), 'scripts', 'tdx_fetch.cjs')
      : VENDORED_SCRIPT;

  const base = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };

  const definitions = [
    {
      name: 'tdx_chain',
      description:
        '拉取创业板ETF(159915)某月完整期权链（含每一档行权价、看涨/看跌合约代码、IV、Greeks、expiredDate）。'
        + '这是 IV/HV 信号系统的唯一权威链数据来源。month 必填，形如 2611；不确定时先调 tdx_months。'
        + '返回 tdx-connector 原始快照，落盘可版本化。',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: '期权月份，4 位如 2611。先调 tdx_months 获取可选月份。' },
          underly: { type: 'string', description: '标的中文代码，默认 159915。' },
          underlyMarket: { type: 'string', description: '标的市场代码，默认 0（深市）。' },
          wantNum: { type: 'number', description: '拉取档位数，默认 100。必须足够大，否则只剩远虚值档。' },
        },
        required: ['month'],
        additionalProperties: false,
      },
      argv: (args) => {
        const out = ['chain', '--month', String(args.month)];
        if (args.underly) out.push('--underly', String(args.underly));
        if (args.underlyMarket) out.push('--underlyMarket', String(args.underlyMarket));
        out.push('--wantNum', String(args.wantNum ?? 100));
        return out;
      },
    },
    {
      name: 'tdx_months',
      description:
        '列出某标的当前可交易的期权月份。拉期权链前先用它确认月份，不要猜。',
      parameters: {
        type: 'object',
        properties: {
          underly: { type: 'string', description: '标的中文代码，默认 159915。' },
          underlyMarket: { type: 'string', description: '标的市场代码，默认 0（深市）。' },
        },
        additionalProperties: false,
      },
      argv: (args) => {
        const out = ['months'];
        if (args.underly) out.push('--underly', String(args.underly));
        if (args.underlyMarket) out.push('--underlyMarket', String(args.underlyMarket));
        return out;
      },
    },
    {
      name: 'tdx_kline',
      description:
        '拉取日线/周线/月线 K 线。用于算 HV10/HV20/HV60 与趋势结构（均线排列、距 MA20）。'
        + '注意：T 的起算日是最后一根 K 线的日期，不是抓取日。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '证券代码，默认 159915。' },
          setcode: { type: 'string', description: '市场：0=深市 1=沪市 9=期权腿，默认 0。' },
          period: { type: 'string', description: '周期：4=日线(默认) 5=周线 6=月线。' },
          count: { type: 'number', description: 'K 线根数，默认 90。算 HV60 至少给 70。' },
        },
        additionalProperties: false,
      },
      argv: (args) => {
        const out = ['kline', '--code', String(args.code ?? '159915'), '--setcode', String(args.setcode ?? '0')];
        if (args.period) out.push('--period', String(args.period));
        out.push('--count', String(args.count ?? 90));
        return out;
      },
    },
    {
      name: 'tdx_quote',
      description:
        '拉取实时行情快照（最新价、买卖五档、成交量）。用于拿标的现价，或按 setcode=9 逐腿拉期权真实买卖价——'
        + 'T-quote 的 NOW 不是盘口价，要真实 bid/ask 必须用这个。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '证券代码，如 159915 或期权腿 8 位代码。' },
          setcode: { type: 'string', description: '市场：0=深市 1=沪市 9=期权腿，默认 0。' },
        },
        required: ['code'],
        additionalProperties: false,
      },
      argv: (args) => ['quote', '--code', String(args.code), '--setcode', String(args.setcode ?? '0')],
    },
  ];

  const disposers = definitions.map((def) => {
    try {
      const dispose = ctx.tools.register({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            kind: { type: 'string' },
            fetchedAt: { type: 'string' },
            reinitCount: { type: 'number' },
            data: { type: 'object' },
            text: { type: 'string' },
          },
          required: ['ok'],
          additionalProperties: true,
        },
        render: (_args, value) => {
          if (!value.ok) {
            return [{ type: 'text', text: value.text ?? '[取数失败] 未知原因' }];
          }
          return [{ type: 'text', text: value.text ?? JSON.stringify(value.data ?? {}).slice(0, 8000) }];
        },
      },
      async execute(args) {
        const fetched = await runFetch(scriptPath, def.argv(args ?? {}));
        if (!fetched.ok) {
          return { ok: false, kind: def.name, text: renderFailure(def.name, fetched) };
        }
        const data = fetched.data;
        // tdx_fetch.js 已经带了 source / fetchedAt / reinitCount，原样透出便于观测会话自愈次数。
        const reinit = typeof data?.reinitCount === 'number' ? data.reinitCount : 0;
        const head = data?.textHead ? `${data.textHead}\n\n` : '';
        const tail = reinit > 0 ? `\n[session] 取数过程中重新握手 ${reinit} 次（MCP 会话已自愈）` : '';
        return {
          ok: true,
          kind: def.name,
          fetchedAt: data?.fetchedAt ?? '',
          reinitCount: reinit,
          data,
          text: `${head}${JSON.stringify(data, null, 2)}${tail}`,
        };
      },
      });
      return dispose;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-tdx-tools: 注册 ${def.name} 失败：${String(error?.message ?? error)}`);
      return () => {};
    }
  });

  // fiber 卸载时统一注销，避免热重载后重复注册。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* best effort */
        }
      }
    }, 'dsh-tdx-tools: unregister tools');
  }

  ctx.logger?.info?.(`dsh-tdx-tools: registered ${definitions.length} tools from ${scriptPath}`);
}

export { runFetch, DEFAULT_PROJECT_ROOT };
