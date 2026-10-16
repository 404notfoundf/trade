# 指定池报价与套利架构设计

> 状态：已确认设计；实现进度与待办见 [TODO](TODO.md)。  
> 日期：2026-10-14  
> 范围：OKX CEX、X Layer Uniswap V3、Solana Raydium CLMM，以及固定 XSPCX/USDC Orca Whirlpool 与 Meteora DLMM 的指定池观察与报价第一期。

## 1. 背景

当前观察链路在策略扫描时调用 OKX DEX Aggregator。该模式把 DEX HTTP 调用、全局限速队列和 CEX 订单簿新鲜度串在同一条关键路径上：等待 Aggregator 返回后再检查 CEX 簿，可能得到“DEX quote 已返回、CEX 簿已经过期”的结果。

目标架构改为独立维护 CEX 与 DEX 市场状态：

```text
OKX books WebSocket ─────────────────────┐
                                        ├─ 策略决策 / 指定数量报价
X Layer 指定 Uniswap V3 池状态 ──────────┤
                                        ├─ direct_pool_decision
Solana 指定 Raydium CLMM 池状态 ─────────┘
                 │
                 └─ direct_pool_quote
```

Orca Whirlpool 通过独立 Adapter 汇入同一观察链路，不经过 Raydium 池状态解析。
Meteora DLMM 也由独立 Adapter 订阅固定 LbPair 并用官方 SDK 报价；两个 Adapter 的断线均 fail-closed。

策略只在本地 CEX 簿、池状态和一次指定池 exact-in quote 都有效时做决策。它不依赖 Aggregator 为系统发现路径，也不允许 Aggregator 的限速队列阻塞报价。

## 2. 已确认决策

| 主题 | 决策 |
| --- | --- |
| CEX | 第一阶段只实现 OKX；注册表允许未来登记其他 CEX。 |
| 链与协议 | 支持 X Layer Uniswap V3、Solana Raydium CLMM，以及固定 XSPCX/USDC Orca Whirlpool、Meteora DLMM；各协议使用独立 Adapter。 |
| DEX 路径 | 单池、单跳、固定 Router/Program、固定 token 对；禁止多跳、拆单和未知 Router 路径。 |
| 多池 | 每方向按配置中的固定优先级依次尝试。主池不赚钱或不可用时可尝试下一池；不按实时最优收益动态选路。 |
| X Layer quote | 经已验证 QuoterV2 用 `eth_call` 执行 `quoteExactInputSingle`。 |
| Solana quote | 使用锁定版本的 Raydium SDK，在一致的 Pool State/Tick Array 快照上本地计算 exact-in。 |
| CEX/DEX 关联 | `instrument_id` 为跨场所业务主键；地址、交易对和显示 symbol 都只是 listing 属性。 |
| 稳定币 | 交易候选必须为资产与该链固定报价币的直接池：X Layer 为 USDT0，Solana 为 USDT。USDG/USDC 等池只可观察，观察估值按配置口径标记 1:1 假设。 |
| 包装资产 | 包装 token 池必须 `observe_only`，理由为 `wrapper_required`；CEX 买入后以 `previewDeposit` 估算可得 wrapper 份额、以 `previewMint` 折算目标份额所需底层资产，DEX 买入后以 `previewRedeem` 折算底层资产。X Layer EVM XNVDA 数量已含 Backed multiplier，不重复相乘；结果仍不可执行。 |
| 新鲜度 | 池价格不变不等于失效。连接、回补、RPC 快照和状态版本决定池健康；CEX 继续使用独立订单簿新鲜度规则。 |
| 触发 | CEX 簿或池状态变化时标记 dirty；每条路线经 200--250ms 合并窗口后报价。每轮只轮换一个配置规模。 |
| 失败 | 单池失败局部熔断与退避，继续尝试下一优先池。身份失配必须人工修正注册表并显式 re-arm；不得自动恢复。 |
| 库存 | 只使用预置在 OKX 与每条链钱包中的库存；不自动充值、提币、跨链或补货。 |
| Aggregator | 最终不属于决策或交易路径；迁移期可以以 `aggregator_shadow: true` 被动记录对照数据。故障时绝不自动回退。 |
| 第一批执行资格 | 全部 direct-pool 决策固定为 `NOT_EXECUTABLE`；Solana observe-only 模拟可用独立钱包签名后调用 `simulateTransaction`，不广播。 |
| 数据 | 旧 Aggregator 表保留，新系统使用新的 raw quote 表和决策表，二者不混合。 |
| 切换 | 新代码通过约定测试后，由显式配置切换至 `direct_pool`；不以累计运行天数为条件。 |

## 3. 目标与非目标

### 3.1 第一批目标

1. 用市场注册表声明链、OKX、DEX 协议、标的和人工审核过的池。
2. 启动时验证链、池、token、精度、手续费、factory/program 与报价/成交端点身份。
3. 维护 CEX 订单簿和池状态，按状态变化合并执行固定金额 exact-in quote。
4. 为每个池的每次 quote 记录原始结果；为每次策略评估记录 CEX 快照、池版本、成本、收益和阻断原因。
5. 在不广播交易的前提下，验证 X Layer calldata 与 Solana 指令构造、最低输出和链上模拟。
6. 通过新的指定池 Dashboard 页面展示状态、quote 和决策；旧页面继续服务旧数据/影子对照。

### 3.2 第一批非目标

- 不自动执行指定池 swap，不改变现有 Aggregator Executor 的真实资金行为。
- 不自动处理 wrap/unwrap、充值、提币、跨链桥、库存补货或再平衡。
- 不支持多跳、拆单、动态最优路由、自动发现池或自动加入新池。
- 不把边际价（`slot0`/Pool State 当前价格）当作固定金额成交价。
- Token-2022 不作为交易候选；仅登记的 XNVDA/USDC 与 SPCXx/USDC Raydium、固定 XSPCX/USDC Orca 和 Meteora observe-only 池可按各自明确扩展白名单报价和模拟。其他 Token-2022 mint、未知扩展、转账费、启用中的 transfer hook 和暂停 mint 均拒绝。
- Orca Whirlpool 与 Meteora DLMM 的池健康由各自 Adapter 订阅、校验和重连，不交给只识别 Raydium Pool State 布局的固定池监听器。

## 4. 配置模型

### 4.1 文件职责

`config.yaml` 保留运行参数、数据库、Dashboard、交易总闸、市场数据开关和密钥引用。新增 `market-registry.yaml`，保存静态且可审核的市场能力注册表。

运行参数新增：

```yaml
marketdata:
  quote_provider: direct_pool       # direct_pool | aggregator（迁移前兼容值）
  aggregator_shadow: true           # 仅记录对照；不能生成决策或可执行机会
  coalesce_window_ms: 250
  direct_quote_retention_days: 7
  direct_decision_retention_days: 180
```

`quote_provider: direct_pool` 下，任何 direct-pool 故障都 fail-closed；不得隐式调用 Aggregator。

### 4.2 注册表示例

以下仅说明结构，地址字段使用不可直接运行的占位符，禁止将占位地址注册为 `trade_candidate`。真实注册表应填写已核验的协议部署地址；带密钥的端点和凭据不得写入 example、日志或文档。

```yaml
schema_version: 1

chains:
  xlayer:
    chain_id: 196
    kind: evm
    rpc_http: "env:XLAYER_RPC_URL"
    rpc_ws: "env:XLAYER_WS_URL"
    native_symbol: OKB
  solana:
    chain_id: 501
    kind: svm
    rpc_http: "env:SOLANA_RPC_URL"
    rpc_ws: "env:SOLANA_WS_URL"
    native_symbol: SOL

cexes:
  okx:
    kind: cex
    enabled: true
    book_source: websocket

dexes:
  uniswap_v3_xlayer:
    chain: xlayer
    adapter: uniswap_v3
    quote_source: onchain_quoter
    quoter_v2: "<verified X Layer QuoterV2 address>"
    swap_router: "<verified X Layer Router address>"
    factory: "<verified X Layer factory address>"
  raydium_clmm_solana:
    chain: solana
    adapter: raydium_clmm
    quote_source: local_math
    program_id: "<verified Raydium CLMM program address>"

instruments:
  - instrument_id: XNVDA
    cex_listings:
      - venue: okx
        symbol: XNVDA-USDT
        currency: XNVDA
    chain_assets:
      - chain: xlayer
        address: "<verified XNVDA address>"
        decimals: 18
        quote_asset:
          symbol: USDT0
          address: "<pinned USDT0 address>"
          decimals: 6
      - chain: solana
        address: "<verified XNVDA mint>"
        decimals: 8
        quote_asset:
          symbol: USDT
          address: "<pinned USDT mint>"
          decimals: 6

pools:
  - id: xnvda-xlayer-primary
    instrument_id: XNVDA
    chain: xlayer
    dex: uniswap_v3_xlayer
    mode: trade_candidate           # trade_candidate | observe_only
    enabled: true                   # optional; defaults to true; false disables this pool
    verified: true
    priority: 10
    max_notional_usdt: "100"
    address: "<verified direct XNVDA/USDT0 pool>"
    token_in_out:
      asset_address: "<must equal chain_assets address>"
      asset_decimals: 18
      quote_address: "<must equal pinned USDT0 address>"
      quote_decimals: 6
    expected_fee_tier: 500

  - id: xnvda-xlayer-wrapped-observe
    instrument_id: XNVDA
    chain: xlayer
    dex: uniswap_v3_xlayer
    mode: observe_only
    enabled: true
    reason: wrapper_required
    verified: true
    address: "<verified wXNVDA/other-quote pool>"
```

### 4.3 配置约束

加载器必须拒绝以下情形：

- 重复的 `instrument_id + chain + pool address`；
- `trade_candidate` 未设置 `verified: true`、`priority` 或 `max_notional_usdt`；
- 交易池 token 与该 `chain_assets` 地址不一致；
- 交易池报价 token 与该链固定报价币不一致；
- 未知 DEX Adapter、链/DEX 不匹配、无效地址或无效精度；
- EVM 池未配置或不匹配预期 factory、fee tier、QuoterV2、Router；
- Raydium 池未配置或不匹配预期 Program ID；
- `observe_only` 池被标为交易候选，或 `wrapper_required` 池试图进入候选集。

池级 `enabled` 为可选布尔值，省略时默认为 `true`；设为 `false` 后，该池不进入交易候选、只读报价或池状态监控。重新启用时设为 `true` 并重启采集器；已有历史记录仍保留。

不配置真实、已验证的直接池时，该资产不生成 direct-pool 路线；进程正常运行，并报告 `not_configured`。

在 `quote_provider: direct_pool` 下，已登记且 `verified: true` 的 `observe_only` 池会进入只读监控，并按观测规模记录 Exact-In 与同规模 CEX VWAP 观察决策。USDG/USDC 当前明确按 1:1 假设折成 USDT；固定 Gas 预算按配置扣除，收益状态标记 `ASSUMED_1_TO_1`。X Layer Wrapper 通过 `asset()` 校验底层 XNVDA：CEX 买入、存入路径用 `previewMint` 将目标 wrapper 份额折成所需底层资产，DEX 买入、赎回路径用 `previewRedeem` 将 wrapper 份额折成底层资产；EVM XNVDA 余额已反映 Backed multiplier，不再手动重复换算。用于收益换算的预览与 DEX Exact-In 报价使用同一 X Layer 区块；换算失败只阻断 X Layer 收益估算，原始池报价与 Solana 路线独立运行。`direct_pool_observation.simulation_enabled` 打开时，合格的 Solana observe-only 报价会由 `SOLANA_SIMULATION_PRIVATE_KEY` 对应的钱包签名并调用模拟 RPC；缺少钱包库存或手续费余额时记录跳过。模拟不广播，也不会改变 `NOT_EXECUTABLE` 执行资格。池 token decimals 必须在注册表中填写并由链上身份核对确认。

## 5. 运行时架构

### 5.1 路线求解

运行时不读取旧 `assets[].routes[]` 来写死 CEX/DEX 配对，而是从 registry 求得候选：

```text
OKX listing(instrument_id)
∩ chain_assets(instrument_id, chain)
∩ enabled DEX on that chain
∩ verified trade_candidate direct pool
∩ direct token pair with the chain pinned quote asset
= direct-pool route candidates
```

候选按 `priority` 升序排列。优先级只表示尝试顺序：前一池无有效 quote、超过单池上限、滑点/成本不合格或净收益不合格时，才尝试下一池。系统不会向所有池并发询价再取最高收益。

每个活跃周期使用 `(instrument_id, chain)` 锁，并由 `instrument_id` 级总敞口限制跨链合并暴露。

### 5.2 Adapter 边界

所有协议通过统一接口接入；Collector、风控和存储不得出现协议/链专用分支。

```ts
type PoolVersion = {
  chain: "xlayer" | "solana";
  blockNumber?: bigint;
  blockHash?: string;
  slot?: bigint;
  observedAt: number;
};

type ExactInQuote = {
  poolId: string;
  direction: "asset_to_quote" | "quote_to_asset";
  amountInRaw: bigint;
  amountOutRaw: bigint;
  minimumAmountOutRaw: bigint;
  priceImpactPercent: string;
  networkFeeNativeRaw: bigint | null;
  networkFeeUsdt: string | null;
  version: PoolVersion;
  quotedAt: number;
  raw: unknown;
};

interface PoolAdapter {
  verify(pool: RegisteredPool): Promise<void>;
  watch?(pool: RegisteredPool, callbacks: {
    onState(state: { slot: bigint; observedAt: number; stateFingerprint: string; marginalPrice?: string }): void;
    onUnavailable(reason: string, identityMismatch?: boolean): void;
  }): Promise<() => Promise<void>>;
  quoteExactIn(input: QuoteInput): Promise<ExactInQuote>;
  buildSwap(input: VerifiedExecutionInput): Promise<UnsignedSwap>;
  simulateSwap(input: UnsignedSwap): Promise<SimulationResult>;
}
```

`buildSwap` 与 `simulateSwap` 是第一批的验证能力，不授予执行权限。未来新增 DEX 只能新增 Adapter，不得直接在 Collector/Executor 内堆叠协议分支。

### 5.3 X Layer Uniswap V3 Adapter

- 启动验证 `chainId`、factory、`token0`、`token1`、token decimals、fee tier、QuoterV2 和 Router。
- WebSocket 监听 `Swap`、`Mint`、`Burn`，断线后通过 RPC 快照和日志回补恢复；沿用池事件的幂等和重组处理。
- exact-in 报价调用已验证的 `QuoterV2.quoteExactInputSingle`，请求固定为登记的池 token 对与 fee tier。
- quote 记录 RPC block number/hash；交易模拟与第二阶段执行前必须重新读取并检查版本仍可接受。
- 网络费使用 Quoter gas estimate 与配置的 gas price 上限/安全系数估算；无法可靠估算即不得进入可执行资格。

### 5.4 Solana Raydium CLMM Adapter

- 启动验证 Pool State、mints、decimals、Raydium CLMM Program ID 与账户布局。
- WebSocket 订阅 Pool State；用锁定版本的 Raydium SDK 读取必要 Tick Array 并执行 exact-in 本地计算。SDK 会分多次 RPC 读取，期间 slot 前进属于正常情况。
- quote 记录读取完成时的 slot、所读 Tick Array 和状态指纹；构建/模拟时重新读取并校验指纹。该 slot 是读取完成标记，不代表 SDK 各次账户读取的原子 context；单一 context 校验见 [TODO](TODO.md)。
- 所有 Solana 交易候选仍仅允许传统 SPL Token。只读例外仅限已登记的 XNVDA/USDC 与 SPCXx/USDC observe-only 池：允许已核验的 metadata、permanent delegate、默认账户状态、Scaled UI Amount、未暂停的 Pausable、无活动程序的 Transfer Hook 与当前 Confidential Transfer 配置；转账费、启用中的 hook、暂停状态、未知扩展及其他 Token-2022 mint 均拒绝。
- 对该池用同批 RPC context 读取 Clock 与 mint，按链上时间选取当前有效 Scaled UI multiplier；池计算、报价存储和最低输出继续使用链上 raw 数量，CEX 股数/收益和 Dashboard 展示换算为 UI 数量。
- `observe_only` 是硬边界：Token-2022 池只能在模拟开关开启时构造 simulation-only 指令并模拟，不能广播，也不能因只读报价或模拟成功而提升为 `trade_candidate`。
- 网络费来自构造交易后的 fee 与 priority fee 估算；未知费用不能进入可执行资格。

Raydium 固定监听器只解析 Raydium CLMM `PoolState`；不得复用来读取 Orca Whirlpool 或 Meteora DLMM 账户。

### 5.5 Orca Whirlpool 与 Meteora DLMM Adapter

两个固定 observe-only 池由各自 Adapter 订阅主账户（Orca Whirlpool / Meteora LbPair），健康恢复前先做 RPC 快照和身份复核。账户变化只触发合并报价，不解释为逐笔 swap；exact-in 报价分别由官方协议 SDK 和所需 tick/bin arrays 完成。DLMM 部分消耗、账户 owner 或固定 mint/bin-step 身份不符时关闭报价。两者只构造 simulation-only unsigned swap，不广播。

## 6. 状态、新鲜度与报价调度

### 6.1 状态原则

| 状态 | 含义 | 对交易候选的影响 |
| --- | --- | --- |
| CEX book stale | 本地簿接收时间或交易所时间超过既有阈值 | 停止该次决策。 |
| Pool quiet | 没有 Swap，价格未变 | 不视为故障。 |
| Pool connection unhealthy | WebSocket 断开、回补失败或订阅异常 | 停止该池候选。 |
| RPC snapshot failed | 不能获得/核验当前池状态 | 停止该池候选。 |
| Pool identity mismatch | token、fee、factory/program、Router/Quoter 任何一项不匹配 | 安全事件：人工修复 registry 并显式 re-arm 前不得恢复。 |
| Quote failed | 当前 exact-in 失败或不完整 | 局部退避，尝试下一优先池。 |

不可使用“最后一次成功 quote”继续交易。池状态变化少不影响观察，但交易前的 exact-in quote 必须是本轮新产生的、附带链状态版本的报价。

### 6.2 合并调度

1. OKX book 更新或池状态更新时，将对应 `(instrument_id, chain)` 标记为 dirty。
2. 每条路线各自以 `coalesce_window_ms`（初值 250ms）合并重复更新。
3. 一次运行只选择轮换到的一个 `observationSizesUsdt`；避免同一状态变化下多档 quote 形成新队列。
4. 对两个方向分别构造 exact-in：
   - `cex_buy_dex_sell`：依据 CEX ask VWAP 和 multiplier 得到链上资产输入量，执行 `asset_to_quote` quote；
   - `dex_buy_cex_sell`：以配置规模的固定报价币为输入，执行 `quote_to_asset` quote，再依据 CEX bid VWAP 估算可卖份额。
5. 候选池按优先级顺序尝试；一个池的失败或无利润不阻断下一池。
6. 第一座通过所有经济与安全闸门的池成为该方向的 selected quote；同时所有尝试均写入原始 quote 表。

## 7. 策略、成本与复核

### 7.1 统一策略输入

策略层消费的不是边际价，而是：

- 同一决策窗口内的 CEX 簿快照和 CEX VWAP；
- exact-in `amountInRaw`、`amountOutRaw`、价格影响、池 ID；
- X Layer block/hash 或 Solana slot；
- CEX 手续费、DEX 协议费（已反映于 quote）和 Adapter 网络费；
- 稳定币估值、multiplier、预置库存和 instrument/chain 风险限额。

候选交易路线的净收益必须基于已核验的估值和所有已知成本。观察路线另行保存假设收益：扣除 CEX 手续费和配置的固定 Gas 预算，估值标记 `ASSUMED_1_TO_1`；CEX 深度不足、订单簿变化或 Wrapper 预览失败时只保存报价并记录收益阻断原因。USDG/USDC 真实兑换成本与 OKB/SOL 实时 Gas 折算仍待接入，因此观察收益不代表可成交净收益。

### 7.2 成交前复核（第二阶段的强制契约）

第二阶段即使允许真实执行，也必须在广播前重新执行：

1. 读取最新 CEX 簿，并再次验证其新鲜度和目标规模 VWAP；
2. 重新读取/验证池状态版本；
3. 重新 quote 或模拟；
4. 校验实际 `amountOutMinimum`、允许滑点、token 对、Router/Program、接收地址；
5. 检查预置余额、链原生 gas 余额和 `(instrument_id, chain)` 锁；
6. 若任一步失败，取消本次周期，绝不回退到 Aggregator。

第一阶段虽会构造和模拟交易，但所有 `direct_pool_decision.execution_status` 固定为 `NOT_EXECUTABLE`。

## 8. 数据模型与保留策略

旧 `quote_observation`、`opportunity`、`report` 服务于 Aggregator 语义，不修改其 schema，也不把 direct-pool 数据写入其中。

### 8.1 `direct_pool_quote`

一条记录代表一次对某个池、某个方向、某个输入额的 raw exact-in 尝试，包括失败尝试。核心字段：

- `id`、`scan_id`、`instrument_id`、`chain_index`、`pool_id`、`dex`；
- `direction`、`amount_in_raw`、`amount_out_raw`、`minimum_amount_out_raw`；
- `price_impact_percent`、`network_fee_native_raw`、`network_fee_usdt`；
- EVM `block_number`/`block_hash` 或 Solana `slot`，以及池状态摘要/指纹；
- `quoted_at`、`request_ms`、`status`、`failure_code`、`failure_reason`、`raw_response`；
- `created_at`。

索引至少覆盖 `(instrument_id, chain_index, quoted_at)`、`(pool_id, quoted_at)`、`(scan_id)` 和保留清理时间。

### 8.2 `direct_pool_decision`

一条记录代表一次策略决策，不论最终选中、无机会或被阻断。核心字段：

- `id`、`scan_id`、`instrument_id`、`chain_index`、`direction`、`size_usdt`；
- `selected_quote_id`（可空，关联 `direct_pool_quote`）；
- CEX book 时间、接收时间、seqId、bid/ask 与本次 VWAP；
- CEX fee、DEX 网络费、独立记录的观察 Gas 预算、估值输入、gross/net profit、ROI；
- `valuation_status`、`decision_status`、`block_reason`；
- `execution_status`，第一期仅允许 `NOT_EXECUTABLE`；
- `created_at`。

`scan_id` 用于把同一次 CEX/池状态触发的多个池尝试关联起来。决策表不需要复用旧 `opportunity` 窗口语义。

### 8.3 保留与清理

- `direct_pool_quote`：保留 7 天；
- `direct_pool_decision`：保留 180 天；
- 现有 `dex_pool_event` 与 `dex_pool_history_gap`：保留 7 天；
- 保留任务按显式配置执行，并记录删除数量/失败健康事件。

## 9. Dashboard、日志与告警

新增“指定池机会”页面，至少包含：

- 每条路线的 CEX 簿状态、池连接/快照/身份状态、当前 quote provider；
- 每座池的模式（`trade_candidate`/`observe_only`）、优先级、验证状态和不可交易原因；
- 最新 raw quotes、被选中的池、次优池失败原因、链状态版本和收益瀑布；
- `NOT_EXECUTABLE` 的明确标记，避免把第一期的观察收益误读成实盘机会；
- Aggregator shadow 对照页或对照列，但不能与 direct-pool 决策混合统计。

日志必须使用 pool ID、instrument ID、chain、scan ID 和失败码，不能记录密钥、签名交易、完整敏感 RPC URL 或未经脱敏的私钥材料。

## 10. 迁移与切换

### 10.1 实施顺序

1. 引入 registry 解析、强校验和 Adapter 注册机制；保持旧配置与旧 Collector 不变。
2. 为已有池监控补齐 direct-pool 运行时状态接口。
3. 实现 Uniswap V3 exact-in quote 与 Raydium CLMM exact-in quote。
4. 创建 direct-pool 两张表、写入器、保留清理和指定池 Dashboard。
5. 实现 shadow 对照：同一 CEX 快照可以记录 Aggregator quote 与 direct-pool quote，但只有 direct-pool 写入新决策表。
6. 增加交易构造与不广播模拟；保持 `NOT_EXECUTABLE`。
7. 完成测试后，把 `marketdata.quote_provider` 显式切为 `direct_pool`。Aggregator shadow 是否继续由 `aggregator_shadow` 人工控制。

### 10.2 回滚

- 配置回滚只能由人工将 `quote_provider` 切回兼容模式；不允许 direct-pool 运行时自行回退。
- 新表和旧表独立，切换/回滚不会破坏旧历史。
- pool 身份失配时不执行自动回滚、不自动换同名池，必须修正 registry 并 re-arm。

## 11. 测试与切换门槛

以下全部通过后，允许人工切换 `quote_provider: direct_pool`：

1. TypeScript 编译和现有回归测试；
2. registry 解析与 fail-closed 校验 fixture，包括地址、token、fee、factory/program、报价币、模式和重复配置；
3. 路线求解、优先级降级、单池上限、包装池 observe-only、故障不回退 Aggregator 的单元测试；
4. Uniswap V3 Adapter 的身份验证、QuoterV2 exact-in 编码/解码和状态版本测试；
5. Raydium CLMM Adapter 的 Pool State、Tick Array、状态指纹、传统 SPL Token 拒绝/接受和 exact-in 测试；
6. X Layer 对真实已审核池执行只读 `eth_call` quote smoke test；
7. Solana 对真实已审核池执行 SDK quote smoke test；
8. 两条链都能构造指定池交易并完成不广播模拟；
9. 新表写入、保留清理、Dashboard 和 shadow 对照测试；
10. 证明所有第一期 `direct_pool_decision` 均为 `NOT_EXECUTABLE`，且现有自动交易执行器不会读取该表。

## 12. 第二阶段边界

第二阶段才讨论 direct-pool 真实成交状态机、成交腿顺序、库存锁、失败补偿、人工对账、wrap/unwrap Adapter、扩展到其他 Token-2022 mint/扩展或其执行、自动补货/跨链，以及其他 DEX Adapter。它们均不得以“第一期 quote 可用”为由自动启用。

## 13. 安全不变量

1. 未验证池、地址不匹配池、包装资产池、未知 token 扩展池永远不能进入第一期交易候选。
2. 边际价永远不能替代 exact-in 结果。
3. 任何 direct-pool 故障均不得自动调用 Aggregator 作为交易回退。
4. 身份失配需要人工修复和 re-arm；普通网络故障才允许退避恢复。
5. 第一批不签名、不广播，所有 direct-pool 决策必须 `NOT_EXECUTABLE`。
6. 真实池地址、协议端点与凭据必须经人工核验；缺失时以 `not_configured` 失败关闭，而不是使用占位值。
