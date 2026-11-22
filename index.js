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

/** 把响应整形（去元数据尾巴、精简 wenda 信封）并截断；提示必须可操作。 */
function clamp(json, hint) {
  return client.shape(json, hint);
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
      const text = clamp(json, hint);
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

    // ---------- 查询与筛选 ----------

    {
      name: 'tdx_lookup',
      description:
        '按名称、简称或别名检索证券代码与市场代码。'
        + '调用其他工具前若不确定代码，应先用它确认；期货用 range=QH，期权标的使用 range=QQ。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '证券名称、简称或别名，如「贵州茅台」「茅台」「腾讯」。' },
          range: {
            type: 'string',
            description: '检索范围：AG（A股，默认）、HK-GP（港股）、JJ（基金）、ZS（指数）、QH（期货）、QQ（期权标的）、MG-GP（美股）。',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: run('tdx_lookup_stock', (a) => ({
        query: String(a.query),
        ...(a.range ? { range: String(a.range) } : {}),
      })),
    },
    {
      name: 'tdx_screener',
      description:
        '按自然语言条件筛选证券，返回符合条件的列表。'
        + '支持技术面（涨停、放量、MACD 金叉）、资金面（主力净流入、北向流入）、基本面（低 PE、高股息）。'
        + '适合「找一批股票」，不适合查某只已知股票的指标（那用 tdx_indicator）。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '选股条件，如「涨停」「主力净流入」「MACD金叉且放量」。' },
          range: { type: 'string', description: '范围：AG（A股，默认）、HK-GP（港股）、JJ（基金）、ZS（指数）。' },
          pageSize: { type: 'number', description: '返回条数，默认 10。' },
          pageNo: { type: 'number', description: '页码，默认 1。' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      execute: run('tdx_screener', (a) => ({
        message: String(a.message),
        ...(a.range ? { rang: String(a.range) } : {}),
        pageSize: String(a.pageSize ?? 10),
        pageNo: String(a.pageNo ?? 1),
      }), '减小 pageSize 或换更精确的条件。'),
    },
    {
      name: 'tdx_indicator',
      description:
        '查询已知证券的估值与财务指标，一次可取多项：PE(TTM)、PB、ROE、市值、股息率、营收、净利等。'
        + '支持多标的对比（「贵州茅台和五粮液的市盈率对比」）。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '必须同时包含实体与目标，如「贵州茅台 市盈率」「宁德时代 ROE,毛利率」。' },
          range: { type: 'string', description: '范围：AG（A股个股，默认）、ZS（指数）、JJ（基金）。' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      execute: run('tdx_indicator_select', (a) => ({
        message: String(a.message),
        ...(a.range ? { rang: String(a.range) } : {}),
      })),
    },

    // ---------- F10 深度数据 ----------

    {
      name: 'tdx_f10',
      description:
        '查询个股 F10 结构化资料：财务报表（利润表/资产负债表/现金流量表）、股东与机构持仓、'
        + '资金流向、分红融资、龙虎榜、主营构成、股本结构等。'
        + 'entry 必填，需精确指定接口名；不确定时先看返回的可用 entry 列表。默认按页返回以避免超长响应。',
      parameters: {
        type: 'object',
        properties: {
          entry: {
            type: 'string',
            description:
              '接口名。常用：TdxShareCW.ph_agf10_cw_lyb（利润表）、TdxShareCW.ph_agf10_cw_zcfzb（资产负债表）、'
              + 'TdxShareCW.ph_agf10_cw_xjllb（现金流量表）、TdxSharePCCW.tdxf10_gg_gdyj（股东）、'
              + 'TdxSharePCCW.tdxf10_gg_jyds（资金流）、TdxSharePCCW.tdxf10_gg_fhrz（分红）、'
              + 'TdxSharePCCW.tdxf10_gg_gsgk（公司基本）。',
          },
          code: { type: 'string', description: '证券代码（纯数字），如 600519。' },
          fixedTag: { type: 'string', description: '子类型。财务类：00101=年报、00102=季报；股东类：ltgd=流通股东、jgcg=机构持仓、kggd=控股股东。' },
          pageNo: { type: 'number', description: '页码，默认 1。' },
          pageSize: { type: 'number', description: '每页条数，默认 20（服务端上限约 100）。' },
          reportDate: { type: 'string', description: '报告期，如 20241231。' },
        },
        required: ['entry', 'code'],
        additionalProperties: false,
      },
      execute: run('tdx_api_data', (a) => ({
        entry: String(a.entry),
        code: String(a.code),
        ...(a.fixedTag ? { fixedTag: String(a.fixedTag) } : {}),
        pageNo: String(a.pageNo ?? 1),
        pageSize: String(a.pageSize ?? 20),
        ...(a.reportDate ? { reportDate: String(a.reportDate) } : {}),
      }), '调小 pageSize、指定 reportDate，或换更具体的 entry / fixedTag。'),
    },

    // ---------- 资讯 ----------

    {
      name: 'tdx_listening',
      description:
        '获取单个标的或板块最近 24 小时的资讯聚合摘要与多空事件分析。'
        + '适合「最近发生了什么」「有什么重要消息」这类概览需求；要逐条看原文用 tdx_news / tdx_notice / tdx_report。',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: '格式「市场代码_品种代码」：A股 0_000001 / 1_600519 / 2_430047；港股 31_00700；板块 1_880564。',
          },
          date: { type: 'string', description: '查询日期 YYYY-MM-DD。缓存约 3 天，超出范围可能返回空。' },
        },
        required: ['code'],
        additionalProperties: false,
      },
      execute: run('tdx_ai_listening', (a) => ({
        setcode_code: String(a.code),
        ...(a.date ? { date: String(a.date) } : {}),
      })),
    },
    {
      name: 'tdx_news',
      description:
        '查询财经新闻、快讯与主题热点。涉及「最新」「最近」等时效性需求时必须调用，并把日期换算成具体区间传入。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '主体名称：公司名 / 股票名 / 板块名。' },
          bdate: { type: 'string', description: '起始日期 YYYYMMDD。含相对时间词时必须填写。' },
          edate: { type: 'string', description: '截止日期 YYYYMMDD，默认今日。' },
          keywords: { type: 'string', description: '关键词过滤，逗号分隔，如「业绩,营收」。' },
        },
        additionalProperties: false,
      },
      execute: run('wenda_news_query', (a) => ({
        ...(a.name ? { name: String(a.name) } : {}),
        ...(a.bdate ? { bdate: String(a.bdate) } : {}),
        ...(a.edate ? { edate: String(a.edate) } : {}),
        ...(a.keywords ? { keywords: String(a.keywords) } : {}),
      }), '缩小日期区间或增加 keywords 过滤。'),
    },
    {
      name: 'tdx_notice',
      description:
        '查询上市公司公告：临时公告、定期报告（年报/季报/半年报）、监管文件等。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '公司全称或简称。' },
          bdate: { type: 'string', description: '起始日期 YYYYMMDD。含相对时间词时必须填写。' },
          edate: { type: 'string', description: '截止日期 YYYYMMDD，默认今日。' },
          keywords: { type: 'string', description: '关键词过滤，如「分红,回购,董事会」。' },
        },
        additionalProperties: false,
      },
      execute: run('wenda_notice_query', (a) => ({
        ...(a.name ? { name: String(a.name) } : {}),
        ...(a.bdate ? { bdate: String(a.bdate) } : {}),
        ...(a.edate ? { edate: String(a.edate) } : {}),
        ...(a.keywords ? { keywords: String(a.keywords) } : {}),
      }), '缩小日期区间或增加 keywords 过滤。'),
    },
    {
      name: 'tdx_report',
      description:
        '查询券商研报：评级调整（买入/增持/中性/减持）、目标价、观点摘要、深度报告。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '公司名或行业名，如「比亚迪」「半导体行业」。' },
          bdate: { type: 'string', description: '起始日期 YYYYMMDD。含「最近」等相对时间时必须填写。' },
          edate: { type: 'string', description: '截止日期 YYYYMMDD，默认今日。' },
          keywords: { type: 'string', description: '关键词过滤，如「评级,目标价」。' },
        },
        additionalProperties: false,
      },
      execute: run('wenda_report_query', (a) => ({
        ...(a.name ? { name: String(a.name) } : {}),
        ...(a.bdate ? { bdate: String(a.bdate) } : {}),
        ...(a.edate ? { edate: String(a.edate) } : {}),
        ...(a.keywords ? { keywords: String(a.keywords) } : {}),
      }), '缩小日期区间或增加 keywords 过滤。'),
    },
    {
      name: 'tdx_macro',
      description:
        '查询宏观经济数据：GDP、CPI、PPI、社融、M2、利率、汇率、进出口、就业、人口等。'
        + 'query 必须用管道格式「主体|起始日期|截止日期|关键词|描述」，日期不可留空。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '管道格式，如「中国|20260101|20261231||CPI」。五段依次为：主体|bdate|edate|keywords|desc。',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: run('wenda_macro_query', (a) => ({ query: String(a.query) })),
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
