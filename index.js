/**
 * dsh-tdx-tools — 将通达信 MCP 行情服务注册为 DeepSeek Harness 原生工具。
 *
 * 架构（0.2.0 起）：
 *   本模块直接持有常驻 TdxClient（lib/tdx-client.cjs），工具调用走进程内 HTTP，
 *   不再为每次调用 spawn 子进程。
 *
 *   为什么改：
 *     实测每次 spawn 新进程约 564ms（进程启动 + 重新握手 + 请求），
 *     复用常驻会话约 170ms。12 个工具连续调用可省约 4 秒。
 *
 *   会话策略：
 *     整个 DSH 进程共用一条 MCP 会话；失效时自动重新握手并重放，
 *     并发失效只会触发一次握手（已测：10 并发 / 1 次握手）。
 *
 * 契约（与 dsh-ops 一致）：
 *   cordis.patch.yml insert 一行 {id, name:'dsh-tdx-tools'}
 *   → loader 加载本包 main，调用 apply(ctx, config)
 *   → inject=['tools']，通过 ctx.tools.register 注册工具
 */

export const name = 'dsh-tdx-tools';

/** 需要 tools 服务才能注册工具。 */
export const inject = ['tools'];

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包根目录（ESM 下可靠）。 */
const ROOT = dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const client = require('./lib/tdx-client.cjs');

/** 本地包版本，随返回结构一并透出，便于排查「装的是哪个版本」。 */
let PKG_VERSION = '0.0.0';
try {
  PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
} catch {
  /* 版本读不到不影响功能 */
}

// ---------- 结果整形 ----------

/** 从 MCP 工具结果里取可供模型阅读的文本，并去掉候选元数据尾巴。 */
function textOf(json) {
  const t = client.extractText(json);
  return client.stripTail(t);
}

/** 把超长响应截断，避免撑爆上下文；提示必须可操作。 */
const MAX_CHARS = 24_000;
function clamp(text, toolName, hint) {
  if (text.length <= MAX_CHARS) return text;
  return (
    text.slice(0, MAX_CHARS) +
    `\n\n[已截断] 原始 ${text.length.toLocaleString()} 字符，仅显示前 ${MAX_CHARS.toLocaleString()}。\n` +
    `原因：${toolName} 返回全量数据。\n` +
    `建议：${hint || '缩小查询范围（如指定 code / period / 分页）后重试。'}`
  );
}

/** 统一失败渲染：明确是「没取到数据」，不是「数据为空」。 */
function renderFailure(toolName, err) {
  const code = err?.code || 'FETCH_FAILED';
  const advice = {
    NO_TOKEN: '设置环境变量 TDX_MCP_TOKEN 后重启 dsh web。',
    QUOTA_EXHAUSTED: '到 https://vip.tdx.com.cn 充值后即可恢复，无需改配置。',
    SESSION_EXPIRED: '自动重建会话失败，通常是网络中断；稍后重试即可。',
    TIMEOUT: '请求超时，检查网络后重试。',
    FETCH_FAILED: '服务端返回错误，稍后重试；若持续失败请检查 token 是否有效。',
  }[code] || '稍后重试。';

  return [
    `[取数失败] ${toolName}`,
    `code: ${code}`,
    `detail: ${String(err?.message ?? err).slice(0, 400)}`,
    ``,
    advice,
    ``,
    `注意：这不是空数据，是没取到数据。不要据此推断行情。`,
  ].join('\n');
}

// ---------- 工具定义 ----------

export function apply(ctx) {
  /** 通用执行包装：调用 MCP 工具 → 截断 → 结构化返回。 */
  const run = (toolName, argBuilder, hint) => async (args) => {
    try {
      const c = await client.getClient();
      const json = await c.callTool(toolName, argBuilder(args ?? {}));
      const text = clamp(textOf(json), toolName, hint);
      const st = client.stats();
      return {
        ok: true,
        tool: toolName,
        version: PKG_VERSION,
        reinitCount: st.reinitCount,
        text,
      };
    } catch (err) {
      return {
        ok: false,
        tool: toolName,
        version: PKG_VERSION,
        text: renderFailure(toolName, err),
      };
    }
  };

  const definitions = [
    {
      name: 'tdx_quote',
      description:
        '获取实时行情快照，包含最新价、买卖五档与成交量。'
        + '需要期权单腿的真实买卖报价时应指定 setcode=9 —— T-quote 返回的 NOW 字段并非盘口价。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '证券代码，如 510050、159915，或 8 位期权合约代码。' },
          setcode: { type: 'string', description: '市场代码：0=深圳 1=上海 9=期权单腿，默认 0。' },
        },
        required: ['code'],
        additionalProperties: false,
      },
      execute: run('tdx_quotes', (a) => ({
        code: String(a.code),
        setcode: String(a.setcode ?? '0'),
      })),
    },
    {
      name: 'tdx_kline',
      description:
        '获取日线 / 周线 / 月线 K 线数据，可用于计算历史波动率与判断趋势结构。'
        + '注意：时间区间的起点是最后一根 K 线所对应的交易日，而非取数当日。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '证券代码，如 510050、159915。' },
          setcode: { type: 'string', description: '市场代码：0=深圳 1=上海 9=期权单腿，默认 0。' },
          period: { type: 'string', description: '周期：4=日线（默认）、5=周线、6=月线。' },
          count: { type: 'number', description: '返回 K 线根数，默认 90。' },
        },
        required: ['code'],
        additionalProperties: false,
      },
      execute: run('tdx_kline', (a) => ({
        code: String(a.code),
        setcode: String(a.setcode ?? '0'),
        period: String(a.period ?? '4'),
        wantNum: String(a.count ?? 90),
        tqFlag: '1',
      }), '减少 count，或改用周线/月线。'),
    },
    {
      name: 'tdx_months',
      description:
        '列出指定标的当前可交易的期权月份及各自到期日。调用 tdx_chain 前应先通过本工具确认月份。',
      parameters: {
        type: 'object',
        properties: {
          underly: { type: 'string', description: '标的代码，如 510050（上证50ETF）、510300（沪深300ETF）。' },
          underlyMarket: { type: 'string', description: '标的市场代码：0=深圳 1=上海。' },
        },
        required: ['underly'],
        additionalProperties: false,
      },
      execute: run('tdx_option_t_quote', (a) => ({
        underlyMarket: String(a.underlyMarket ?? '0'),
        underlyCode: String(a.underly),
        wantNum: 100,
      })),
    },
    {
      name: 'tdx_chain',
      description:
        '获取指定月份的完整期权链，包含各档行权价、看涨/看跌合约代码、隐含波动率、'
        + 'Greeks 与到期日。month 为必填项，格式如 2611；月份不确定时应先调用 tdx_months。'
        + '返回服务端原始快照，可用于落盘与回溯分析。',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: '期权月份，4 位如 2611。建议先经 tdx_months 确认。' },
          underly: { type: 'string', description: '标的代码，如 510050（上证50ETF）、510300（沪深300ETF）。' },
          underlyMarket: { type: 'string', description: '标的市场代码：0=深圳 1=上海。' },
          wantNum: { type: 'number', description: '返回档位数，默认 100。取值过小将只得到远虚值档位。' },
        },
        required: ['month', 'underly'],
        additionalProperties: false,
      },
      execute: run('tdx_option_t_quote', (a) => ({
        underlyMarket: String(a.underlyMarket ?? '0'),
        underlyCode: String(a.underly),
        month: String(a.month),
        wantNum: Number(a.wantNum ?? 100),
      }), '降低 wantNum，或指定 underlyPrice 只看平值附近档位。'),
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
              tool: { type: 'string' },
              version: { type: 'string' },
              reinitCount: { type: 'number' },
              text: { type: 'string' },
            },
            required: ['ok'],
            additionalProperties: true,
          },
          render: (_args, value) => [{ type: 'text', text: value.text ?? '' }],
        },
        async execute(args) {
          return def.execute(args);
        },
      });
      return dispose;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-tdx-tools: 注册 ${def.name} 失败：${String(error?.message ?? error)}`);
      return () => {};
    }
  });

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            /* best effort */
          }
        }
        // 插件卸载时主动结束会话，避免服务端堆积。
        void client.closeClient?.();
      },
      'dsh-tdx-tools: unregister tools',
    );
  }

  ctx.logger?.info?.(`dsh-tdx-tools v${PKG_VERSION}: registered ${definitions.length} tools (shared session)`);
}

export { PKG_VERSION };
