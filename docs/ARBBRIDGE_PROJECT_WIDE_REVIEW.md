# ArbBridge 对本项目的全项目优化审查

日期：2026-10-16
状态：当前架构与后续优化参考
范围：对照 ArbBridge 的策略、定量、收益核算和可复算边界，检查本项目的 Aggregator 与 Direct Pool 采集、估值、交易、Adapter、存储和运行入口。本文是静态代码审查，不代表线上收益已验证。

## 结论

本项目已经有 ArbBridge 值得借鉴的关键基础：CEX 与 DEX 使用实际数量报价、按方向取对应盘口、协议实现隔离在 Adapter、记录 quote 与状态版本、观察决策和交易执行分离。池身份校验、Token-2022 白名单、失败关闭和模拟不广播等边界应继续保留。

进一步优化的重点不是照搬 ArbBridge 的策略，而是让本项目不同路径对同一组市场输入得出同一套收益结果，并能从存档数据复算。当前 Direct Pool 还没有启用的交易候选池，候选路径也没有可通过的 quote 估值状态；因此最先要解决的是估值门槛和观测数据可比性。规模求解应等这些基础数据可信后再做。

ArbBridge 的方向、收益公式和实现边界详见[定价与收益核算参考](ARBBRIDGE_PROFIT_CALCULATION_LESSONS.md)。

## 当前实现扫描

- `config.yaml` 当前选择 `quote_provider: direct_pool`，`aggregator_shadow: false`。`market-registry.yaml` 中启用的池是 XSPCX/USDC Orca `observe_only`；没有 `trade_candidate`。
- Direct Pool 候选扫描要求 `quoteValuationStatus === "VERIFIED"`，但 `main.ts` 传入的状态目前固定为 `UNKNOWN`。这是保守的关闭状态；在接入真实报价币估值前，不能只把状态改成 `VERIFIED`。
- `DirectPoolCollector` 同时包含触发调度、两方向报价、候选池排序、收益计算、记录决策和模拟流程。观察路径的输入量根据开始时的 CEX 中间价计算，报价返回后又取最新盘口计算收益；记录的决策快照因此不一定是 sizing 使用的原始快照。
- 收益算术已统一到 `src/market/profit-calculation.ts`：Aggregator 和交易执行经 `src/market/valuation.ts` 调用，Direct Pool 观察与候选直接调用。ROI 按买入腿本金计算；执行门槛另用包含费用的 `capitalAtRiskUsdt`。Direct Pool 与旧 Aggregator 使用独立表；`direct_pool` 模式会关闭旧交易执行器，两个路径没有自动混用。
- 已有的保护包括：各协议独立 Adapter、池身份和状态指纹校验、quote 与 decision 通过 `scan_id` 关联、观察收益标注估值状态、Direct Pool 固定 `NOT_EXECUTABLE`，以及交易执行前重报价、复核余额和状态。
- 测试已有 registry、Adapter、pool state、prepare 等覆盖；当前仍没有 `collector`、Direct Pool collector、`valuation` 或 `executor` 的专用测试。仓库提供离线 `npm test`，运行现有 `*.test.ts` 与 `*.check.ts`。

## 优先优化项

### P0：先打通 Direct Pool 候选估值

**依据：** 当前没有启用的交易候选池；即使新增候选，`main.ts` 仍向 `DirectPoolCollector` 固定传入 `quoteValuationStatus: "UNKNOWN"`，候选扫描会以 `QUOTE_VALUATION_UNKNOWN` 跳过。

**建议：** 为 Direct Pool 候选接入明确的 quote token 估值结果，包括 token 地址匹配、价格来源与时间、新鲜度、稳定币偏离保护和转换成本。只有这些检查都通过，才产生 `VERIFIED`。观察池的 USDC/USDT 1:1 假设继续单独标注，不用于候选交易估值。

**完成标准：** 对固定报价币候选，估值结果能指出来源、时间和阻断原因；对缺失或过期价格继续关闭候选；同一组 quote 输入可离线复算并得到相同收益。

### P0：建立共享、纯函数收益核算（核算层已实现）

**依据：** 此项实施前，主要重复计算位于 `direct-pool-collector.ts` 的观察路径和候选路径；ROI 投入额也有不同口径。当前没有发现方向符号反转。

**实现：** 已在 `src/market/profit-calculation.ts` 抽出无 I/O 的纯函数，对已归一到同一计价单位的金额核算。`src/market/valuation.ts` 将 Aggregator、执行前检查和成交后估算委托给它；Direct Pool 观察与候选在报价币归一后直接调用。函数按方向推导买入腿本金，返回成本拆分、毛利、净利、投入额、总风险资金、ROI 和不可计算原因。Adapter 仍只负责协议报价，不计算跨市场收益。

统一公式：

```text
CEX 买入、DEX 卖出：毛利 = DEX quote 收入 − CEX 买入额
DEX 买入、CEX 卖出：毛利 = CEX 卖出额 − DEX quote 支出
净利 = 毛利 − CEX 手续费 − 本次选用的网络成本 − 再平衡成本 − 其他独立成本
```

投入本金建议统一为买入腿本金：CEX 买入方向使用 CEX VWAP 成交额；DEX 买入方向使用 DEX 实际 quote 输入额。Aggregator 的安全门槛 `netMarginOk` 可保留当前 all-in 资金基数，但应与 ROI 的 `investedUsdt` 分开命名，避免重构时暗中改变执行门槛。

**边界：**

- Exact-In 的输出已反映池内费与该次报价的价格影响；不得再重复扣同一笔 DEX 费或冲击。
- 网络成本每次核算只选一个口径：观察 Gas 预算、报价预估、模拟估算或链上实付。保留来源与状态；若它们对应同一笔交易，不得相加。
- `VERIFIED`、`ASSUMED` 和 `UNKNOWN` 必须区分。估值未知时不返回伪精确的 USDT 净利；采用明确假设时可以计算，但结果标为 `ASSUMED` 并记录假设来源。
- 旧执行器写入的 `post_fill_net_profit_estimate_usdt` 仍是成交后估算：它以链上余额变化和 CEX 成交均价复算，但当前 CEX 手续费按费率估算、Gas 沿用成交前报价估算。除非改为使用实际手续费和链上实付网络费，不得称为已实现盈亏。
- 金额运算继续使用 `Decimal`，不得把原始整数金额转成 JavaScript `number`。

具体利润公式和报价估值边界见[定价与收益核算参考](ARBBRIDGE_PROFIT_CALCULATION_LESSONS.md)。

**验证进度：** 已有双向符号、成本、负利润、未知估值/费用、非法金额和 Decimal 精度测试；另验证了盘口跨档与深度不足，并更新 `valuation.check.ts`。Aggregator、Direct Pool 观察/候选与 Executor 的专用调用方测试仍待补，因此本项尚未归档。

**剩余完成标准：**

- 纯函数测试覆盖双向符号、负利润、费用/其他成本扣减、零或无效投入额、未知估值和 Decimal 精度边界；确认池费与价格影响不会重复扣除。
- 调用方测试覆盖 Aggregator、Direct Pool 观察、Direct Pool 候选和执行器对输入字段的归一。相同规范化输入必须产生相同的毛利、成本拆分、净利和 ROI。
- 盘口跨档和深度不足通过 VWAP/调用方测试验证：深度不足目标规模时不得给整笔交易报利润；若主动缩小规模，必须按缩小后的实际数量重算。
- 成交后输出继续明确标为估算，直到手续费与链上网络费均来自实际成交记录。

### P1：让一次 scan 真正可复算、可配对

**依据：** 观察路径以 scan 开始时的中间价推算资产输入量；DEX/Wrapper 调用结束后，`recordObserveDecision` 会用最新 CEX 盘口估值。当前决策记录保存后一个盘口的时间和 seqId，没有同时保存用来推算输入量的原始 CEX 快照。另一个方向在无法推算资产输入量、且无可用边际价时不会报价。

**建议：** 明确区分“报价 sizing 快照”和“收益 valuation 快照”，保存各自时间、seqId、价格档位摘要及两者间隔。若间隔超过设定上限，标记该方向不可比较或重新报价。Dashboard 和离线统计按 `scan_id + pool_id + size + 估值状态` 配对，分别报告双向成功数、失败数、缺失方向原因和正收益率，不将缺失方向当作零利润。

**完成标准：** 给定一条决策记录可确定它使用的 CEX 盘口版本、DEX 池版本、原始输入数量、估值价格与所有成本；方向比较只汇总达到时间差和状态版本要求的成对样本。

### P1：用实测曲线优化规模，不复制单报价近似

**依据：** 当前观察路径轮换 `observationSizesUsdt` 中的规模，每轮只采一个规模；Direct Pool 候选路径对选定规模逐池、逐方向报价。ArbBridge 结合 CEX 深度和一个 DEX 报价构造 RFQ 单档近似，并非完整 DEX 曲线。

**建议：** 在 P0/P1 数据可信后，按方向分别计算 CEX 盘口可成交深度，并对受限的几个 DEX Exact-In 规模实时报价；在实际网络费、quote 估值和池上限后选择净利最大的规模。先离线复算现有规模数据，再决定是否增加报价档位或做自适应搜索，避免为尚无可执行池的路线增加 RPC 负载。

**完成标准：** 与当前固定规模基线比较，报告双向可比样本、候选规模、报价耗时、净收益和拒绝原因；不同规模报价必须使用相近的 CEX 与池状态。

### P1：统一观察、候选、模拟和成交的收益瀑布

**依据：** P0 统一算术后，各路径仍会使用不同的成本来源和估值置信度：旧 Aggregator 有 Gas safety buffer 与再平衡成本；Direct Pool 观察使用配置 Gas 预算及 1:1 假设，候选路径使用 Adapter 网络费，Solana 模拟费用另行记录。不同状态的收益数字不能仅因公式相同就当作同一口径比较。

**建议：** 复用 P0 的收益拆分，在 Dashboard 和存储中展示：DEX 收付金额及报价币换算、CEX VWAP、毛利、CEX 费、选用的网络成本、稳定币转换成本、再平衡成本、执行缓冲、净利与 ROI。每项记录来源和状态，明确区分 `ASSUMED`、`QUOTED`、`SIMULATED`、`REALIZED`。只有所有纳入净利的实际费用都来自成交/链上记录时，才标为 `REALIZED`；模拟不成功、价格过期或成本未知时，不给出伪精确的净收益。

**完成标准：** 每个收益数字都能追溯到原始金额与成本来源；观察估值、交易模拟和实际成交报表不互相覆盖或混合统计。

### P2：为候选路线补上库存与失败成本约束

**依据：** 旧执行器已有库存预检与交易周期状态；Direct Pool 当前固定不可执行，实盘规划也要求预置库存、锁和单腿失败处理。ArbBridge 的 inventory skew 值得参考，但不会替代本项目的链上/交易所余额检查。

**建议：** 只有进入 Direct Pool 执行阶段后，再把 CEX 与链上可用库存、单笔/总敞口、补仓或再平衡成本、失败后已发生费用和对冲约束纳入候选打分与执行状态机。先按预置库存运行，不在定价模块中隐式假设资金可跨场所移动。

**完成标准：** 候选收益明确扣除已确认的库存成本；库存不足、cycle 未完成或发生单腿成交时阻止新周期，并保留对账状态。

### P2：沿定价边界收敛模块职责

**依据：** `main.ts` 承担启动编排、健康状态、池历史持久化、定时任务和关闭流程；`DirectPoolCollector` 同时做报价、决策和模拟；旧 `executor.ts` 同时包含两方向交易周期与多链交易细节。现有 Adapter 已为协议边界提供了清晰切入点。

**建议：** 先完成共享收益核算与它的测试，再按真实维护摩擦逐步拆分 Direct Pool 的扫描和持久化职责。运行仍维持单进程；在没有跨进程状态共享或多实例协调需求前，不新增 Redis 或服务拆分。给现有 `node:test` 测试提供统一运行入口，避免新增的定价回归只能靠手工检查。

**完成标准：** 新增协议只需实现 Adapter 契约；更改收益公式不需要同时编辑多个 Collector/Executor；开发者能用仓库提供的单一命令运行相关回归。

## 实施顺序

1. 保持当前观察与执行边界，先实现可审计的 Direct Pool 报价币估值；在存在合格池以前不启用候选交易。
2. 补齐共享核算在 Aggregator、Direct Pool 观察/候选与 Executor 的调用方归一化测试（核算函数及基础边界测试已完成）。
3. 保存 sizing 与 valuation 两组市场快照，构建按 scan 配对的离线复算与方向统计。
4. 用成对历史数据决定是否做多规模报价和规模求解。
5. 随维护需求收敛 Collector/Executor 边界，并给核心回归建立统一运行入口。
6. Direct Pool 执行阶段单独接库存、真实费用和失败补偿，沿用现有独立执行状态机规划。

## 暂不建议照搬的部分

- ArbBridge 的候选排序与单次 DEX 报价 RFQ sizing 近似，不能当作 CLMM、Whirlpool 或 DLMM 的真实多规模成交曲线。
- ArbBridge 当前成功概率配置为 1；其期望收益实现不等于本项目已验证的链上执行概率模型。
- 不用观察样本方向占比、单次模拟通过或标记为 `VERIFIED` 的价格估值，推断长期可实现利润。
- 不替换本项目已有的池身份验证、Adapter、Token-2022 范围限制、状态指纹和 fail-closed 机制。

## 审查范围与限制

本次检查了运行入口、两条 Collector、估值与交易执行路径、Direct Pool Adapter/存储、配置、迁移、Dashboard 相关查询和现有文档；没有连接数据库核对线上样本，没有读取密钥，没有调用链 RPC，也没有运行测试或实盘模拟。因此本文可以定位代码路径和当前配置阻塞，不能确认生产环境的收益分布、调用延迟或链上报价误差。

主要代码位置：[main.ts](../src/main.ts)、[collector.ts](../src/collector.ts)、[direct-pool collector](../src/direct-pool/collector.ts)、[valuation.ts](../src/market/valuation.ts)、[executor.ts](../src/trading/executor.ts)、[market-registry.yaml](../market-registry.yaml)。
