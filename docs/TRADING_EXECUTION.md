# 交易执行与恢复

## 执行策略

- 全局配置 `trading.enabled` 默认关闭；本机 `/trade` 页面还需单独启动。页面开关不持久化，进程重启后自动关闭。
- 执行器按库存检查两个方向：CEX 有 USDT 且链上有 AAPLx 时，可 CEX 买入 `XAAPL-USDT`、链上卖出 AAPLx；链上有 USDT0/USDT 且 CEX 有 XAAPL 时，可链上买入 AAPLx、CEX 卖出 XAAPL。余额不足的方向会跳过。
- X Layer（196）和 Solana（501）分别从各自运行时密钥签名。对每条启用路线检查相关链上代币余额与 OKB/SOL；不要求 CEX 充提网络开放，因为资金已预置。
- 两个方向都先完成并确认链上交易，再按链上实际余额变化计算对冲股数并提交 CEX IOC 限价单。买入方向按 DEX 实际收款限制 CEX 买入价；卖出方向按 DEX 实际花费、手续费、Gas 和 1% 缓冲设定 CEX 最低卖价。
- 例如 CEX 只有 USDT、X Layer 只有 AAPLx 时，只能做 CEX 买、DEX 卖；反向需要 CEX XAAPL 和 X Layer USDT0（或 Solana USDT）库存。
- 每轮金额受 `tradeSizeUsdt` 与 `maxTradeSizeUsdt` 限制；全局 MySQL 命名锁保证同一时刻只有一个周期执行。

## 状态与异常

- `trade_cycle` 保存每轮报价/盘口意图、客户端委托号、准确的 CEX 下单参数与结果、链上实际 token delta 和恢复检查时间；成交后的净收益仍是估算值，手续费和 Gas 按费率/报价估计。`trade_cycle_tx` 保存链交易哈希及确认状态。密钥与签名后的原始交易不会入库。
- 启动时保持 disarm 并扫描所有未终态周期；`/trade` 手动启动时也必须先通过同一恢复检查。`PREPARING` 且无链交易记录表示还未广播，可安全标记 `FAILED`。其余周期必须查询链上实际状态；确认的 swap 再按交易回执/元数据读取实际资产变化，并用已保存的 `clOrdId` 查询 OKX 当前委托及历史记录。
- 只有链上 swap 已确认、实际 delta 方向正确且与提交对冲前保存的 delta 一致，并且 OKX 委托与已保存的币对、方向、数量、限价一致并全额成交时，才自动恢复为 `COMPLETE`。未成交/部分成交或无 CEX 下单意图但 DEX 已成交时进入 `HEDGE_REQUIRED`；链状态未知、订单查询缺失或结果不匹配时进入 `RECOVERY_REQUIRED`。两者都会保持 disarm，且恢复代码没有重发链交易或 CEX 订单的路径。
- `/trade` 显示未完成周期的链交易、客户端委托号、已查到的 OKX 委托 ID/状态及阻断原因。对账人员需核对链上交易、CEX 委托和余额，完成必要对冲后使用“记录人工对账完成”标为 `RECONCILED`。此操作与执行器共用数据库锁，且保持自动交易关闭；再次手动启动时会重新扫描剩余未终态周期。
- 关闭页面开关会阻止新周期；如果链上交易已广播，当前周期仍继续到 CEX 对冲或记录为需人工处理。
- 交易会使用 CEX 现货 IOC 限价单；CEX 与 DEX 不支持原子成交。DEX 成交后若市场跳动或 CEX 只有部分成交，仍可能留下未对冲仓位。

## 链上授权

- X Layer 上的 AAPLx 和 USDT0 需先在钱包中授权给 OKX [`approve-transaction`](https://web3.okx.com/zh-hans/onchainos/dev-docs/trade/dex-approve-transaction) 当前返回的 spender；不要用兑换交易的 `tx.to` 代替。当前使用无限额度，spender 可能变化。
- 程序启动时和每次兑换前都会检查授权额度。额度不足时只阻断需要该代币的交易方向，不会自动签名或广播授权交易。Solana 不使用 ERC-20 授权。

## 凭证

- CEX API Key 仅启用 Read 和 Trade，禁止 Withdraw，并绑定固定 IP。交易与账户查询共用该 Key。
- `XLAYER_PRIVATE_KEY`、`SOLANA_PRIVATE_KEY` 只从进程环境加载，分别对应专用低余额钱包。Solana 支持 base58 私钥或 JSON 字节数组；RPC 可通过 `XLAYER_RPC_URL`、`SOLANA_RPC_URL` 指定。
- `.env` 不入版本控制。禁止在页面、日志、数据库和聊天中输出或保存私钥。

## 运行前

1. 先以 `trading.enabled: false` 观察盘口和报价，确认路线、合约及钱包余额。
2. 配好 CEX Read + Trade Key 与专用链上钱包，再执行 `npm run db:migrate` 应用全部待执行迁移（包括 `017_trade_cycle_recovery.sql`）。
3. 只有在能人工监控并处理 `HEDGE_REQUIRED` 时，才启用配置总闸并在本机页面启动自动交易。
