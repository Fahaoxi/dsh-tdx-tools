# dsh-tdx-tools

DeepSeek Harness 插件：将通达信 MCP 行情服务注册为原生工具，提供**实时行情、K 线、期权链**三类数据能力。

---

## 特点

- **常驻会话**：整个 DSH 进程共用一条 MCP 会话，不必每次调用重新握手
- **会话自愈**：检测到服务端回收会话时自动重建并重放，无需人工干预
- **并发安全**：多个工具同时调用互不干扰，共享同一次握手
- **失败即报错**：区分未配置 / 配额不足 / 会话失效 / 超时，给出可操作建议
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

未配置 token 时，工具返回 `NO_TOKEN` 错误并提示如何配置，不会返回任何替代数据。

---

## 工具

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `tdx_quote` | 实时行情快照，含买卖五档 | `code`、`setcode` |
| `tdx_kline` | 日 / 周 / 月 K 线 | `code`、`period`（`4` = 日线） |
| `tdx_months` | 可交易期权月份及到期日 | `underly` |
| `tdx_chain` | 某月完整期权链：行权价、合约代码、IV、Greeks、到期日 | `month`、`underly` |

### 推荐调用顺序

```
tdx_months  →  tdx_chain(month)  →  tdx_quote(setcode=9) 逐腿获取实际盘口
```

期权链为**两步调用**：先由 `tdx_months` 取得可用月份，再以该月份调用 `tdx_chain`。月份不应推测。

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

每次调用除业务文本外，还包含以下元信息：

| 字段 | 说明 |
|---|---|
| `ok` | 是否成功 |
| `tool` | 实际调用的服务端工具名 |
| `version` | 插件版本，便于确认装的是哪一版 |
| `reinitCount` | 累计会话重建次数；`0` 表示会话一直正常 |

### 长响应截断

单次返回超过 24,000 字符时自动截断，并附上原始长度与缩小查询范围的建议。这是为了避免挤占模型上下文，不是数据缺失。

---

## 错误处理

| code | 含义 | 处理 |
|---|---|---|
| `NO_TOKEN` | 未配置 `TDX_MCP_TOKEN` | 设置环境变量后重启 |
| `QUOTA_EXHAUSTED` | 通达信配额不足 | 充值后自动恢复 |
| `SESSION_EXPIRED` | 会话失效且重建失败 | 通常为网络中断，稍后重试 |
| `TIMEOUT` | 请求超时 | 检查网络后重试 |
| `FETCH_FAILED` | 服务端返回其他错误 | 检查 token 是否有效 |

配额不足时服务端返回：

```
TDX MCP quota is below 10. Please recharge before continuing.
leftValue: <remaining>
```

到 <https://vip.tdx.com.cn> 充值即可，无需修改配置。

插件遵循**失败即失败**原则：取数异常时返回明确错误码，不以空值或推测值替代。

---

## 性能

| 场景 | 耗时 |
|---|---|
| 首次调用（含握手） | ~350 ms |
| 后续调用（复用会话） | ~150 ms |
| 10 个并发调用 | ~260 ms，共 1 次握手 |

对比每次新建连接的实现（约 560 ms/次），复用会话约快 3.3 倍。

---

## 兼容性

- 与 `@deepseek-ai/dsh-mcp-client` 可共存，互不干扰
- 不修改任何既有配置行（`cordis.patch.yml` 仅注册自身）
- 包内 `scripts/tdx_fetch.cjs` 保留为独立 CLI，可脱离插件单独使用

---

## 许可

MIT License。

本项目为非官方插件，与通达信官方无隶属或合作关系。使用通达信 MCP 服务需自行申请并遵守其服务条款。
