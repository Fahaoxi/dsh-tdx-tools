# dsh-tdx-tools

DeepSeek Harness 插件：将通达信 MCP 行情服务注册为原生工具，提供**期权链、K 线、实时行情**三类数据能力，并内置 MCP 会话自愈。

---

## 特点

- **四个开箱可用的工具**：期权链、可交易月份、K 线、实时行情快照
- **会话自愈**：检测到服务端会话失效时自动重新握手并重放，无需人工干预
- **原生调用**：工具直接进入模型工具列表，与内置工具同等使用
- **失败即报错**：取数异常时返回明确错误码，不以空值或推测值替代
- **即插即用**：复用宿主 Node 运行时，无需额外依赖

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

未配置 token 时，工具返回明确的配置错误，不会返回任何替代数据。

---

## 工具

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `tdx_chain` | 获取指定月份的完整期权链：各档行权价、看涨/看跌合约代码、隐含波动率、Greeks、到期日 | `month`、`underly` |
| `tdx_months` | 列出当前可交易的期权月份及到期日 | `underly` |
| `tdx_kline` | 日 / 周 / 月 K 线 | `code`、`period`（`4` = 日线） |
| `tdx_quote` | 实时行情快照，含买卖五档 | `code`、`setcode` |

### 推荐调用顺序

```
tdx_months  →  tdx_chain(month)  →  tdx_quote(setcode=9) 逐腿获取实际盘口
```

期权链为**两步调用**：先由 `tdx_months` 取得可用月份，再以该月份调用 `tdx_chain`。月份不应推测。

`wantNum` 建议保持较大值（默认 100）：服务端按行权价从高到低返回，取值过小将只得到远虚值档位。

### 使用注意

- **T-quote 的 `NOW` 字段不是盘口价**。需要真实买卖报价时，应对单腿调用 `tdx_quote` 并指定 `setcode=9`。
- **T-quote 返回的 Greeks 与其展示的 IV 不自洽**。如需用于定价或风险计算，应以 BSM 重新计算（无风险利率取 0，T 按日历日 / 365）。

### setcode 对照

| 值 | 市场 |
|---|---|
| `0` | 深圳证券交易所 |
| `1` | 上海证券交易所 |
| `9` | 期权单腿 |
| `31` | 香港交易所 |

---

## 返回字段

每次调用除业务数据外，还包含以下元信息：

| 字段 | 说明 |
|---|---|
| `kind` | 数据类型：`chain` / `months` / `kline` / `quote` |
| `fetchedAt` | 取数时间（ISO 8601） |
| `source` | 数据来源标识 |
| `reinitCount` | 本次调用触发会话自愈的次数；`0` 表示会话正常 |

---

## 错误处理

取数失败时返回 `{ ok: false, code, text }`：

| code | 含义 |
|---|---|
| `SPAWN_FAILED` | 子进程无法启动（运行时缺失或被终止） |
| `TIMEOUT` | 超过 90 秒未返回 |
| `FETCH_FAILED` | 服务端返回错误（含 401 配额不足、会话异常） |
| `BAD_JSON` | 返回内容无法解析为 JSON |

**配额不足**时服务端返回：

```
TDX MCP quota is below 10. Please recharge before continuing.
leftValue: <remaining>
```

在 <https://vip.tdx.com.cn> 充值后即可恢复，无需修改配置。

插件遵循**失败即失败**原则：取数异常时返回明确错误，不以空值或推测值替代，避免下游误判。

---

## 配置项

`apply(ctx, config)` 支持以下可选字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `scriptPath` | 包内 `scripts/tdx_fetch.cjs` | 指定自定义取数脚本 |
| `projectRoot` | — | 指定后使用 `<projectRoot>/scripts/tdx_fetch.cjs` |

通常无需配置。

---

## 兼容性

- 与 `@deepseek-ai/dsh-mcp-client` 可共存，互不干扰
- 不修改任何既有配置行（`cordis.patch.yml` 仅注册自身）

---

## 许可

MIT License。

本项目为非官方插件，与通达信官方无隶属或合作关系。使用通达信 MCP 服务需自行申请并遵守其服务条款。
