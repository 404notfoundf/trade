# Direct Pool 实盘执行规划

> 状态：未实现。当前 Direct Pool 只做观察报价、unsigned swap 构造和不广播模拟；所有决策均为 `NOT_EXECUTABLE`。

## 目标与边界

本阶段将经过人工核验的 Direct Pool 路线逐步升级为真实成交。它不包含自动充值、提币、跨链、补货或包装资产执行；这些仍属于独立结算系统。

当前 Dashboard 的正收益是重复报价的观察估算，不能作为执行授权，也不能累计为实际利润。

## 当前状态

- X Layer 与 Solana Adapter 已支持 `quoteExactIn`、`buildSwap` 和 `simulateSwap`。
- Raydium CLMM 的 `quote_source: local_math` 是使用 Raydium SDK、实时 RPC 池状态和 tick arrays 的 Exact-In 本地计算，不是常数乘积近似值。
- 当前 `xnvda-solana-raydium-clmm` 必须保持 `observe_only`：它使用非固定报价 mint，且是仅为观察开放的 Token-2022 例外；不得直接改为 `trade_candidate`。
- 当前没有已验证且有活跃流动性的 Direct Pool `trade_candidate`；所有决策固定为 `NOT_EXECUTABLE`。

## 可执行路线的前置条件

只有同时满足以下条件的池才能登记为新的 `trade_candidate`：

1. 已人工核验池地址、Program/Factory、Router、token/mint、decimals、fee tier 和 RPC 端点。
2. 池是注册资产与该链固定报价资产的直接交易对；Solana 必须使用固定报价 mint，不能以当前观察池的替代稳定币推断。
3. Solana 执行池必须使用已审核的普通 SPL Token；Token-2022、包装资产、未知扩展池均继续 `observe_only`。
4. 配置包含 `verified: true`、`priority`、`max_notional_usdt`，并通过启动时身份校验。
5. 已完成同池、同规模的本地报价与构造后模拟交易抽样对拍，确认输出、费用和滑点处于预期容差内。

## 报价与成交前校验

`local_math` 可以用于 Raydium 实盘路线，但每笔成交必须重新走以下顺序：

1. 获取 Exact-In 报价并记录状态指纹、slot/block、输入量、输出量和 `minimumAmountOutRaw`。
2. 在允许的最大报价年龄内重新读取池状态；状态指纹、Token-2022 multiplier（如适用）或链状态版本变化则废弃本次报价并重新报价。
3. 构造 unsigned swap，检查 program/router、token 对、接收地址、输入量、最低输出和允许滑点。
4. 执行不广播模拟；模拟输出不得低于 `minimumAmountOutRaw`。
5. 计算网络费和 priority fee，并换算为 USDT。费用未知、模拟失败、报价超时或状态变化均 fail-closed。

## 执行状态机

需要新增独立于 `direct_pool_decision` 的执行 cycle / leg 记录。观察决策表继续保存报价审计，不应兼任真实执行状态机。

建议最小状态流：

```text
SELECTED
  -> PRECHECKED
  -> DEX_SIMULATED
  -> LOCKED
  -> FIRST_LEG_SUBMITTED
  -> FIRST_LEG_CONFIRMED
  -> SECOND_LEG_SUBMITTED
  -> COMPLETE

任一步失败：
  -> CANCELLED（尚未成交）
  -> HEDGE_REQUIRED（已发生单腿或部分成交）
  -> RECONCILED（人工完成余额、订单和链上交易对账）
```

每次状态变更需持久化：`scan_id`、池 ID、方向、报价 ID、CEX 订单 ID、链交易签名/hash、输入输出 raw 数量、实际费用、时间戳、失败码和人工处理说明。

## 风控与库存

提交前必须原子取得 `(instrument_id, chain)` 的库存锁，并检查：

- CEX 与链钱包均有足够的预置库存；
- EVM 账户有足够原生 gas，Solana 钱包有足够 SOL、关联 token account 和输入 token；
- ERC-20 allowance / Solana token account 前置条件已满足；
- 单笔名义金额不超过池的 `max_notional_usdt`，也不超过全局、单标的和日累计限额；
- CEX 订单簿、链报价和网络费用均在新鲜度限制内；
- 同一资产没有未完成 cycle 或 `HEDGE_REQUIRED` 记录。

未知费用、余额不足、身份失配、报价失效或任何健康检查不通过时一律拒绝广播，不回退到 Aggregator。

## 签名、广播和确认

- 私钥或 API 凭据只从受控密钥源读取，禁止写入注册表、页面、日志或数据库 raw 响应。
- 广播前保存 intent，广播后保存交易 hash/signature 和 CEX order ID，避免进程重启后重复下单。
- RPC 返回交易 hash/signature 不等于成交：必须等待链确认，处理 blockhash 过期、替换、回滚、超时和失败回执。
- CEX 与 DEX 两腿的顺序应由风险设计明确决定；任一腿发生部分成交或另一腿失败时，立即冻结该资产并进入 `HEDGE_REQUIRED`，由人工处理或经过审核的补偿规则恢复。
- 不允许因 Direct Pool 失败自动改走 Aggregator。

## 灰度发布

1. 新增一个已审核池，先保持 `trade_candidate` 但只运行 quote / build / simulate 对拍。
2. 对同池、同规模持续记录本地报价、模拟结果和实际池状态差异，达到预设误差与成功率门槛后再申请广播开关。
3. 首次广播仅开放单池、单方向、小额、每日额度上限和人工值守。
4. 每笔完成后对账 CEX 成交、链交易、钱包余额、实际滑点和费用；出现单腿、异常滑点、确认超时或账实差异立即停止该路线。
5. 在稳定运行并完成复盘前，不扩大池数、方向或金额。

## 不在本阶段范围内

- 自动充值、提币、跨链、补货、再平衡；
- 包装资产的 deposit/redeem 执行；
- Token-2022 执行支持；
- 未经单独 Adapter 审核的 Orca、Sushi 或其他 DEX；
- 以 Dashboard 的观察收益自动触发成交。
