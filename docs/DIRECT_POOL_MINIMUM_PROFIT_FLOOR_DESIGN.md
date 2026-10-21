# Direct Pool 最低保守净收益设计

> 状态：第一阶段只读观察已实现；第二阶段交易执行待实施。
> 日期：2026-10-21
> 观察范围：Solana 四个 XSPCX/USDC 池、DEX 买入后 OKX 卖出、100 USDT 观察规模。

## 1. 目标

给观察与后续交易增加统一的保守收益门槛：在所有必需输入有效时，按 DEX 最低输出量、OKX 可用买单深度、手续费和网络费估算的完整成交净收益必须至少为 **0.01 USDT**。

这里的“保守净收益”是一个带有明确输入假设的估算下界，不表示跨 DEX 与 CEX 的绝对盈利保证。两边不能原子成交；DEX 已成交后，OKX IOC 可能未成交或部分成交，仍会留下未对冲资产。

## 2. 现状与约束

- Observe-only Collector 已向 Adapter 传入滑点，并把 `amount_out_raw` 与 `minimum_amount_out_raw` 保存到 `direct_pool_quote`。默认滑点仍为 50 bp；四个 XSPCX/USDC Solana 池在 100 USDT、DEX 买入/CEX 卖出路线使用 10 bp。
- `net_profit_usdt` 保留普通 `amount_out_raw` 口径；新增 `worst_case_net_profit_usdt`，按最低输出数量和 OKX 买单深度计算，并以 `minimum_profit_status` 标记达标、未达标、不可计算或不适用。
- 普通观察收益中的 Solana 网络费按 5,000 lamports 基础费和 SOL-USDT 中间价估算；保守净收益改用 SOL-USDT 卖价估值基础费。两者均未包含优先费或 ATA 租金，不能当作执行时的费用上限。
- 观察决策把 USDC 按 1:1 估值，并标记 `ASSUMED_1_TO_1`。观察通过不能等同于经验证的 USDT 盈利。
- 当前 Solana XSPCX/USDC Orca 池在 `market-registry.yaml` 中是 `observe_only`，原因是 `quote_asset_not_pinned`。Direct Pool 实盘规划要求交易池使用已审核的固定报价 mint；本设计不改变池模式或候选资格。
- 交易路径已有至少 1% 的净边际检查。此设计不降低或移除此门槛。

## 3. 统一计算口径

仅使用精确 raw 数量和 `decimal.js` 金额运算，不把链上 raw 数量转成 JavaScript 浮点数。

对于 DEX 买入、OKX 卖出的方向：

1. 把报价的 `minimum_amount_out_raw` 按 token decimals 和已验证 multiplier 换算成可卖数量。
2. 按 OKX `lotSz` 向下取整；低于 `minSz` 时阻断。
3. 用新鲜的 OKX 买单逐档计算该数量的卖出收入；盘口深度不够时阻断，不用边际价外推。
4. 扣除该卖出收入对应的 CEX 手续费、DEX 输入成本、Solana 网络费估值及已配置的其他成本。
5. 只有数据齐全且 `worst_case_net_profit_usdt >= 0.01` 才通过最低收益线。

```text
保守净收益 = OKX 买单深度卖出收入(DEX 最小输出量)
           - CEX 手续费
           - DEX 输入成本(按对应估值口径)
           - Solana 网络费
           - 其他已配置成本
```

DEX 协议费已反映在 exact-in quote 输出中，不重复扣除。任何必需金额、费率、报价或盘口缺失/过期时，状态为不可计算，不按零成本或零收入处理。

### 3.1 滑点参数

观察阶段对目标池报价使用 **10 bp** 作为试行滑点保护，并从 quote 的 `minimum_amount_out_raw` 计算保守收益。目标池为 Raydium CLMM、Orca Whirlpool、Meteora DLMM 和 Byreal CLMM 上的 XSPCX/USDC；该值仅用于观察验证，不调整这些池的其他方向或规模，也不代表验证出实盘最优值。

实现时必须将此设置限定在目标池/路线，不能因为现有 Collector 的默认值是共享参数而无意改变其他池的报价行为。

### 3.2 成本与估值状态

- 第一阶段沿用当前 Solana 基础费估算和 1:1 USDC/USDT 观察口径，但在记录与界面中明确标记 `ASSUMED_1_TO_1` 及费用来源；通过状态只表示模型门槛通过。
- 交易阶段必须采用可验证的报价币估值与交易前网络费估算。报价币估值不为 `VERIFIED`、费用未知或 ATA 前置条件不满足时，拒绝广播。
- 如果 Solana 交易包含优先费，费用估算必须覆盖该笔交易；若执行策略不使用优先费，也要由交易构造和费用检查确认，而不能只沿用观察阶段的 5,000 lamports 假设。
- ATA 租金不计入正常观察估值。交易前必须核验所需 Token Account 已存在；缺失时阻断，或在单独批准后的成本方案中计入创建成本。

## 4. 阶段一：只读观察

### 行为

- 继续保存原始 quote 与普通口径 `net_profit_usdt`；新增的保守净收益字段不会改变历史净收益含义。
- 对目标池/方向以最小输出量重新估算 OKX 卖出数量、深度、手续费和净收益。
- Dashboard 的收益明细和窗口样本显示普通净收益、保守净收益与 0.01 USDT 门槛状态；估值口径仍显示 `ASSUMED_1_TO_1`。
- 保留未通过和不可计算样本，便于统计机会数量及阻断原因；观察结果始终是 `NOT_EXECUTABLE`，不触发交易。
- 复用现有 DEX quote、CEX book 和 SOL-USDT ticker；不为该计算新增链上 RPC 请求。

### 数据变更

迁移 `023_direct_pool_minimum_profit_floor.sql` 在 `direct_pool_decision` 增加保守净收益和门槛状态字段。Storage、查询与 Dashboard 已更新；既有行的保守收益保持 `NULL`，状态为 `NOT_APPLICABLE`，不回填普通净收益。

`valuation_inputs` 记录足以复算的输入摘要：quote ID、最小输出 raw 数量、token decimals/multiplier、CEX 盘口时间与消耗档位、手续费率、Gas 来源和估值状态。不得写入密钥、签名或原始敏感响应。

### 第一阶段验收

- 低于 0.01 USDT 的保守净收益显示未通过；恰好 0.01 USDT 通过。
- 最小输出量、lot size 取整、订单最小量、盘口逐档成交、CEX 费、Gas 和额外成本均可复算。
- 盘口深度不足、数据过期、估值无效或费用缺失时为阻断/不可计算。
- 只影响上述四个 XSPCX/USDC 池的指定观察路线；其他池及旧净收益统计不改变。
- `execution_status` 仍全部为 `NOT_EXECUTABLE`，不增加 Solana RPC 次数。

## 5. 阶段二：trade 执行

阶段一积累足够观察样本并复核计算后，再将同一收益口径接入 `src/trading/` 中独立的 Direct Pool 执行路径。该路径与 Aggregator 执行保持分离，不做隐式报价回退：

1. 首腿之前重新获取有效 DEX exact-in 报价、`minimumAmountOutRaw` 和新鲜 CEX book；不得复用观察阶段的旧报价。
2. 用保守净收益门槛做交易前准入。保留现有 1% 净边际门槛，组合规则为 `净收益 >= max(0.01 USDT, 投入金额 * 1%)`。
3. DEX 首腿确认后，用实际 token delta、最新 CEX book 和实际可用手续费重算收益，并计算能满足门槛的 CEX 卖出 IOC 限价；若盘口价格已低于该限价，不提交低价订单。
4. 仅全额成交且最终复算通过时记为完成。IOC 未成交、部分成交或结果未知时进入现有 `HEDGE_REQUIRED` / `RECOVERY_REQUIRED` 流程，冻结后续自动下单，不盲目重试。
5. 交易周期保存交易前保守收益、成交数量、实际费用、最终估算收益及阻断/恢复原因，便于事后复核。

**池资格是独立前置条件。** 当前四个 XSPCX/USDC 池继续保持 `observe_only`。第二阶段的收益门槛可以接入 trade，但不能据此允许这些 USDC 池实盘；必须先有符合固定报价 mint、池身份、代币类型及其他执行要求的已审核交易池，并单独完成准入。

## 6. 不能保证的情形

该门槛可以约束报价、DEX 最低输出和 CEX 限价，但无法使两个场所的交易原子化。Solana 交易失败仍可能产生网络费；DEX 成功后，OKX IOC 仍可能部分成交或未成交。因此不能承诺“每次尝试都至少实现 0.01 USDT 利润”。可承诺的范围是：

- 观察报告按保守输入计算出的完整成交净收益不低于 0.01 USDT；
- 执行时只有报价和限价条件满足才提交相应腿；
- 单腿或状态未知时停止新单并进入现有对账流程。

## 7. 实施顺序

1. 阶段一计算、存储与 Dashboard 展示已实现；应用迁移后继续只读观察，检查 10 bp 下的门槛通过率、数据阻断率和报价变化，并复核费用与估值假设。
2. 只有在池本身满足交易候选资格后，才实现阶段二交易门槛、IOC 限价约束与成交后复算；先完成不广播模拟及恢复路径验证，再单独评估是否允许广播。

## 8. 不在本设计范围内

- 将当前 XSPCX/USDC 池改成 `trade_candidate` 或启用真实交易；
- 自动跨链、充值、提现、补货或库存再平衡；
- 把观察估值或模拟结果描述为实际盈利；
- 放宽现有 1% 净边际、交易限额或全局交易开关。
