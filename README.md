# dsh-tdx-tools

把**通达信 MCP（tdx-connector）** 的期权链、K 线、实时行情注册为 DeepSeek Harness 工具。

相比直接用 `@deepseek-ai/dsh-mcp-client` 桥接，本插件的核心差异是：**自带 MCP 会话自愈**。

---

## 为什么需要它

TDX 服务端会主动回收空闲的 MCP 会话。之后每次调用都返回：

```json
{"code":-32000,"message":"Session not found or expired",
 "data":{"errorType":"MCP_SESSION_EXPIRED","retryable":true,"requiresInitialize":true}}
```

实测空闲 **十几分钟到一小时** 就会掉，且 TTL 不稳定。关键点：

- 此时 **HTTP 连接本身还活着**，所以 `reconnect` 配置不会触发（它只在连接断开时生效）
- MCP SDK 没有「检测到会话失效 → 自动重新 initialize」的分支
- `retryable: true` 是**误导字段**：它指「会话可以重建」，不是「重发这个请求就能成功」

结果就是「时好时坏」——重试无效，只能重新握手。

本插件在每次取数前检测 `404 / 400 / -32000`，命中就**重新 initialize 并重放一次**，把这个问题消除掉。返回结构里的 `reinitCount` 会告诉你本次触发了几次自愈。

---

## 安装

```sh
dsh plugin --profile desktop add github:<your-name>/dsh-tdx-tools
```

安装后**重启 dsh web**。工具注册发生在插件加载时，已打开的会话不会自动拿到新工具。

---

## 配置

设置环境变量 `TDX_MCP_TOKEN`（自备，通达信 MCP token）：

```sh
# Windows (PowerShell)
$env:TDX_MCP_TOKEN = "TDX-xxxxxxxxxxxx"
```

带不带 `Bearer ` 前缀都可以，插件会自动补。**token 不写入任何文件，也不打印。**

> 没有 token 时工具会明确报「未配置凭据」，不会返回任何伪造数据。

---

## 工具

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tdx_chain` | 某月完整期权链（每档行权价、合约代码、IV、Greeks、`expiredDate`） | `month`（必填） |
| `tdx_months` | 当前可交易月份列表 | `underly` |
| `tdx_kline` | 日/周/月 K 线 | `period`（4=日线） |
| `tdx_quote` | 实时行情快照（含买卖五档） | `code`、`setcode` |

### 典型调用顺序

```
tdx_months  →  tdx_chain(month)  →  tdx_quote(setcode=9) 逐腿取真实买卖价
```

**期权链要两步**：先 `tdx_months` 拿月份，再 `tdx_chain`。不要猜月份。

**`wantNum` 要给大**（默认 100）。服务端从最高行权价往下返回，给小了只剩远虚值档。

### 两个容易踩的坑

- **T-quote 的 `NOW` 不是盘口价**。要真实 bid/ask，按腿单独调 `tdx_quote`，`setcode=9`。
- **T-quote 自带的 Greeks 和它自己显示的 IV 不自洽**，需要时用 BSM 自行重算（r=0，T=日历日/365）。

### setcode 对照

| 值 | 市场 |
|---|---|
| `0` | 深市（159915 等） |
| `1` | 沪市 |
| `9` | 期权腿 |
| `31` | 港股 |

---

## 错误处理

取数失败返回 `{ ok: false, code, text }`，`code` 取值：

| code | 含义 |
|---|---|
| `SPAWN_FAILED` | 子进程起不来（Node 缺失或被杀） |
| `TIMEOUT` | 超过 90s |
| `FETCH_FAILED` | 端点报错（含 401 配额不足、会话问题） |
| `BAD_JSON` | 输出了非法 JSON |

**配额不足** 会返回：

```
TDX MCP quota is below 10. Please recharge before continuing.
leftValue: 4
```

到 <https://vip.tdx.com.cn> 充值即可，不需要改任何配置。

设计上**失败就是失败**——文案明确写「这不是空数据，是没取到数据」，绝不编造数字。

---

## 配置项

插件 `apply(ctx, config)` 接受：

| 字段 | 默认 | 说明 |
|---|---|---|
| `scriptPath` | 包内 `scripts/tdx_fetch.js` | 显式指定取数脚本 |
| `projectRoot` | — | 指定后改用 `<projectRoot>/scripts/tdx_fetch.js` |

一般不需要配置。

---

## 许可

MIT。与通达信官方无关联，token 由使用者自行申请。
