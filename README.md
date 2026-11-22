# dsh-tdx-tools

DeepSeek Harness 插件：将通达信 MCP 行情服务注册为 **13 个原生工具**，覆盖实时行情、K 线、期权链、条件选股、F10 财务、财经资讯与宏观数据。

---

## 特点

- **13 个工具**：行情 / K 线 / 期权链 / 代码检索 / 选股 / 指标 / F10 / 资讯 / 公告 / 研报 / 宏观
- **常驻会话**：整个 DSH 进程共用一条 MCP 会话，后续调用约 150ms
- **会话自愈**：服务端回收会话时自动重建并重放；并发失效只触发一次握手
- **响应整形**：自动剥离元数据信封、还原表格、超长截断，节省 40% 以上上下文
- **失败即报错**：区分未配置 / 配额不足 / 会话失效 / 超时，各带可操作建议

---

## 安装

```sh
dsh plugin --profile desktop add github:Fahaoxi/dsh-tdx-tools
```

安装后需**重启 dsh web**。工具注册发生在插件加载阶段，已建立的会话不会自动获得新工具。

要求 Node.js ≥ 18。

---

## 配置

通过环境变量提供通达信 MCP token：

```powershell
# Windows PowerShell
$env:TDX_MCP_TOKEN = "<your-token>"
```

```sh
# Linux / macOS
export TDX_MCP_TOKEN="<your-token>"
```

`Bearer ` 前缀可省略，插件会自动补全。**token 仅存在于进程内存，不写入磁盘、不输出到日志。**

未配置时返回 `NO_TOKEN` 错误并提示配置方式，不会返回任何替代数据。

---

## 工具

### 行情与走势

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `tdx_quote` | 实时行情快照，含买卖五档 | `code`、`setcode` |
| `tdx_kline` | 日 / 周 / 月 K 线 | `code`、`period`（`4` = 日线） |

### 期权

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `tdx_months` | 可交易期权月份及到期日 | `underly` |
| `tdx_chain` | 某月完整期权链：行权价、合约代码、IV、Greeks | `month`、`underly` |

### 检索与筛选

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `tdx_lookup` | 名称 → 证券代码（调用其他工具前确认代码） | `query`、`range` |
| `tdx_screener` | 按自然语言条件选股（涨停 / 净流入 / MACD 金叉） | `message` |
| `tdx_indicator` | 已知证券的 PE / PB / ROE / 市值 / 股息率等 | `message` |

### 深度数据

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `tdx_f10` | F10：财报 / 股东 / 资金流 / 分红 / 龙虎榜 | `entry`、`code`、`fixedTag` |

### 资讯

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `tdx_listening` | 单标的 24 小时资讯聚合与多空事件 | `code`（如 `1_600519`） |
| `tdx_news` | 新闻、快讯、主题热点 | `name`、`bdate`、`edate` |
| `tdx_notice` | 上市公司公告 | `name`、`bdate`、`edate` |
| `tdx_report` | 券商研报、评级、目标价 | `name`、`bdate`、`edate` |
| `tdx_macro` | GDP / CPI / PPI / M2 / 利率等 | `query`（管道格式） |

### 典型流程

```
不确定代码      →  tdx_lookup
看某只股票      →  tdx_quote + tdx_kline + tdx_indicator
查基本面        →  tdx_f10（entry=TdxShareCW.ph_agf10_cw_lyb）
找一批股票      →  tdx_screener
期权链          →  tdx_months → tdx_chain → tdx_quote(setcode=9) 逐腿取盘口
了解近期消息    →  tdx_listening / tdx_news / tdx_notice / tdx_report
```

### 使用注意

- **T-quote 的 `NOW` 字段不是盘口价**。需要真实买卖报价时，对单腿调用 `tdx_quote` 并指定 `setcode=9`。
- **T-quote 的 Greeks 与其展示的 IV 不自洽**。用于定价或风控时应以 BSM 重算（无风险利率取 0，T 按日历日 / 365）。
- **`tdx_news` 等资讯工具**：涉及「最近」等相对时间时，应把日期换算成具体 `bdate` / `edate` 再传，否则可能返回过时数据。

### setcode 对照

| 值 | 市场 |
|---|---|
| `0` | 深圳证券交易所 |
| `1` | 上海证券交易所 |
| `9` | 期权单腿 |
| `31` | 香港交易所 |

---

## 返回字段

| 字段 | 说明 |
|---|---|
| `ok` | 是否成功 |
| `tool` | 实际调用的服务端工具名 |
| `version` | 插件版本 |
| `reinitCount` | 累计会话重建次数；`0` 表示一直正常 |

### 响应整形与截断

- 资讯类工具返回的 JSON 信封（含 `request_url`、`elapsed_ms` 等）会被剥离，正文还原为 markdown 表格，平均节省 **44%** 字符
- 单次超过 **24,000 字符**自动截断，并附原始长度与缩小查询范围的建议

截断不是数据缺失，是避免挤占模型上下文。

---

## 错误处理

| code | 含义 | 处理 |
|---|---|---|
| `NO_TOKEN` | 未配置 `TDX_MCP_TOKEN` | 设置环境变量后重启 |
| `QUOTA_EXHAUSTED` | 通达信配额不足 | 充值后自动恢复 |
| `SESSION_EXPIRED` | 会话失效且重建失败 | 通常为网络中断，稍后重试 |
| `TIMEOUT` | 请求超时 | 检查网络后重试 |
| `FETCH_FAILED` | 其他服务端错误 | 检查 token 是否有效 |

配额不足时服务端返回：

```
TDX MCP quota is below 10. Please recharge before continuing.
leftValue: <remaining>
```

到 <https://vip.tdx.com.cn> 充值即可，无需修改配置。

---

## 性能

| 场景 | 耗时 |
|---|---|
| 首次调用（含握手） | ~350 ms |
| 后续调用（复用会话） | ~150 ms |
| 10 个并发调用 | ~260 ms，共 1 次握手 |

对比每次新建连接（约 560 ms/次），复用会话约快 3.3 倍。

---

## 兼容性

- 与 `@deepseek-ai/dsh-mcp-client` 可共存
- 不修改任何既有配置行（`cordis.patch.yml` 仅注册自身）
- 包内 `scripts/tdx_fetch.cjs` 保留为独立 CLI，可脱离插件单独使用

---

## 许可

MIT License。

本项目为非官方插件，与通达信官方无隶属或合作关系。使用通达信 MCP 服务需自行申请并遵守其服务条款。
