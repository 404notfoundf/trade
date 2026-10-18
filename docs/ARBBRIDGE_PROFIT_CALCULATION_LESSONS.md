# ArbBridge 定价与收益核算对我们的启发

日期：2026-10-16
用途：对照 ArbBridge 的双向套利定价实现，明确本项目可借鉴的核算边界与后续验证方法。本文是技术参考，不代表 ArbBridge 的历史数据可直接外推到本项目。

## 结论

代码层面没有发现本项目把 `buy_cex_sell_dex` 的买卖方向写反。这个方向表示在 CEX 买入、在 DEX 卖出；它通常出现在 DEX 的可卖价格高于 CEX 的可买价格时。方向主要由标的、场所和采样时段的相对价格决定，不能用其他观察者的方向占比来判断公式对错。

ArbBridge 最值得借鉴的是把**方向粗筛、按实际数量定价、扣除成本、记录输入以便复算**分开处理。我们当前的 Direct Pool 观察路径已经采用了其中多项做法，当前最需要验证的是同一扫描内双向数据的可比性，以及 USDC/USDT 和 Gas 估值假设。

## ArbBridge 如何计算方向与收益

### 方向筛选

`internal/strategy/form_takertaker.go` 同时构造两个候选方向。DEX 边际价与 CEX 中间价用于计算方向边际；随后沿对应的 CEX 盘口档位累计规模：CEX 卖出取 bids，CEX 买入取 asks。它根据扣除成本地板后的边际选择候选方向。

这里的方向不是固定偏向某一边。项目留档的两个窗口方向符号相反：2026-09-04 的中价偏离中位数为 −11.99 bp（18,723 个样本、3,719 秒），2026-09-10 为 +6.41 bp（1,810 个样本、335 秒）。两段都是有限窗口的中价观测，而且极值都未达到当时的成本地板，不能当作可成交利润证据。详见 ArbBridge `docs/ops/numbers.md` 的“干跑管道的实盘冒烟”部分。

### 按方向定量

选出候选后，`internal/app/execplan/sizer.go` 再按方向选择 CEX 盘口：

- `buy_dex_sell_cex`：CEX 卖出，使用 bids；DEX 报价方向为 quote → asset。
- `buy_cex_sell_dex`：CEX 买入，使用 asks；DEX 报价方向为 asset → quote。

它取 CEX 阶梯深度和一次 DEX Quoter 报价，换算成同一基础币数量口径，再交给 `internal/pricing/solve.go`。该求解器按买腿积分成本、卖腿积分收入，扣 CEX 费、DEX 费和额外冲击成本，并在候选规模中最大化期望收益。

ArbBridge 的 DEX sizing 目前把一次指定规模的 Quoter 报价折成单档 RFQ 价格，不是完整的逐规模 DEX 曲线。代码把该处理作为保守近似；它可能降低可行利润，也可能令不同方向的近似误差不同。因此，对比方向时应同时看筛选边际与最终定量结果。

### 期望收益与成本

当前求解公式为：

```text
净额 = 卖腿收入 − 买腿成本 − CEX 费 − DEX 费 − 额外冲击
期望收益 = 成功概率 × 净额 − (1 − 成功概率) × 失败成本 − Gas − Bid
```

若 DEX Quoter 的输出已经包含池费，调用方会把额外 DEX 费设为零，以免重复扣费。ArbBridge 当前装配的 `SuccessProb` 为 1，因此这次扫描看到的期望收益退化为净额减 Gas 和 Bid。代码另把 `FailureCostUSD` 设成 Gas + Bid；如果未来将成功概率设为小于 1，需要先厘清失败成本是否表示**额外于固定 Gas/Bid 的损失**。按当前字段注释，它也可能包含同一笔 Gas/Bid，存在重复扣减的风险。

## 对本项目的对应检查

当前启用的 XSPCX/USDC Solana 池是 `observe_only`。`src/direct-pool/collector.ts` 每轮都会构造 quote → asset 的 DEX 买入报价；只有 CEX 盘口能换算出目标数量，或池边际价可用于回退换算时，才会同时构造 asset → quote 的 DEX 卖出报价。它在 `recordObserveDecision` 中：

- CEX 买入方向取 asks，DEX 卖出收入减 CEX VWAP 买入成本；
- CEX 卖出方向取 bids，CEX VWAP 卖出收入减 DEX quote 输入成本；
- 再扣 CEX 手续费和配置的 Gas 预算。

这个方向符号和基本毛利计算与 ArbBridge 一致。DEX exact-in 的输出已经反映该笔报价里的池内交易成本/价格影响，不应再把同一成本重复扣一次。项目还会记录报价原始数量、CEX VWAP、手续费、Gas 预算、价格影响和估值输入，足以支持离线复算。

目前的限制需要在报告中保留：

1. 当前观察路径将 DEX 报价资产 USDC 按 `ASSUMED_1_TO_1` 换算为 USDT；它不是实时报价汇率。
2. Gas 使用配置预算，不等于未来实际执行成本。
3. `observe_only` 的净利润是报价估算，不是执行后已实现盈亏。
4. DEX 报价和 CEX 盘口采样时间可能不同；复算时必须使用记录的 `quotedAt`、CEX 时间戳和对应 `scanId`。
5. 并非每个 `scanId` 都必然有两条方向记录；统计方向占比时应单独报告成对样本数和缺失原因。

## 建议的验证方式

对数据库中同一 `scanId`、同一池、同一观测规模且两方向都成功报价的记录，离线重算并保留以下拆项。未成对或失败的记录另行计数，不应默认为零利润：

| 方向 | 毛利 | CEX 手续费 | DEX 网络费 / Gas 预算 | 净利 | 投入金额 | 估值状态 |
| --- | --- | --- | --- | --- | --- | --- |
| CEX 买入、DEX 卖出 | DEX quote 收入 − CEX asks VWAP 成本 | 按 CEX 买入成交额 | 按当前成本来源 | 毛利 − 各项成本 | CEX 买入成本 | 标明 USDC/USDT 汇率假设 |
| DEX 买入、CEX 卖出 | CEX bids VWAP 收入 − DEX quote 支出 | 按 CEX 卖出成交额 | 按当前成本来源 | 毛利 − 各项成本 | DEX quote 支出 | 标明 USDC/USDT 汇率假设 |

再按标的和时间窗口分别统计双向的可用样本数、净利为正比例及净利分位数。先确认原始数量、费率、时间戳和计算结果能逐行对上，再解释方向占比；不要把两个不同采样窗口或不同估值状态混成一个方向结论。

## 本次扫描的代码位置

- ArbBridge：`internal/strategy/form_takertaker.go`、`internal/strategy/candidate.go`、`internal/app/execplan/sizer.go`、`internal/pricing/solve.go`、`internal/pricing/types.go`、`internal/app/assemble_const.go`、`docs/ops/numbers.md`。
- 本项目：[`src/direct-pool/collector.ts`](../src/direct-pool/collector.ts)、[`market-registry.yaml`](../market-registry.yaml)。
