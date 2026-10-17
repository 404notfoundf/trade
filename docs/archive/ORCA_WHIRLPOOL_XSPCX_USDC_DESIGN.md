# Orca Whirlpool XSPCX/USDC 指定池接入设计

> 状态：已实施并归档。固定池身份核验、双向 exact-in quote 与 simulation-only unsigned transaction 构造已通过；未配置本地模拟钱包，因此未调用链上 `simulateTransaction`。  
> 日期：2026-10-15。  
> 范围：Solana 上单个 XSPCX/USDC Orca Whirlpool 的只读报价、观察记录与不广播模拟。  
> 不在范围：真实广播、自动发现池、跨 DEX 路由或合并流动性。

## 1. 目标与结论

在既有 Raydium XSPCX/USDC CLMM 观察之外，增加一个**独立**的 Orca Whirlpool 流动性源。它复用 Direct Pool 的 `PoolAdapter` 契约和 `DirectPoolCollector`，与 Raydium 各自产生报价、观察决策和模拟结果；两者绝不合并储备、绝不形成跨 DEX 路由，也不互为故障回退。

该池及资产被固定为以下身份，而不是按名称发现：

| 项目 | 锁定值 |
| --- | --- |
| instrument | `XSPCX` |
| 资产 mint | `Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8` |
| 资产 decimals | `8` |
| USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDC decimals | `6` |
| Whirlpool 地址 | `ASAxmEaTT1HFe3mVC3zbKDE4tuB28W7732XQrEMBM5W2` |
| Whirlpool Program | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` |
| 模式 | `observe_only`，原因 `quote_asset_not_pinned` |
| 执行状态 | 始终 `NOT_EXECUTABLE` |

`SPCX`、`SPCXx` 等展示名称不能作为配置或身份判断依据。启动验证的链上 mint、pool、program、decimals 与 tick spacing/fee 才是唯一依据。

## 2. 已确认的产品边界

1. 功能包括：池身份验证、固定规模的 exact-in 本地报价、raw 报价/观察决策落库、构建 unsigned swap，以及合格时由现有模拟钱包签名并调用 RPC `simulateTransaction`。
2. 模拟交易绝不发送；模拟成功不得改变 `observe_only` 或 `NOT_EXECUTABLE`。
3. Orca 失败时，只记录该 Orca 池本次失败或跳过原因；现有 Raydium XSPCX/USDC 继续采集。
4. 不增加自动池发现、同名资产匹配、自动切换池、路由拆单或流动性汇总。
5. 不修改既有 Aggregator 数据语义；Direct Pool 数据继续写入 `direct_pool_quote` 和 `direct_pool_decision`。

## 3. 现状与变更范围

现有 `src/trading/pool-adapters.ts` 已有协议无关的 `PoolAdapter`：

```ts
verify(pool)
getAssetUiMultiplier(pool)
quoteExactIn(pool, input)
buildSwap(pool, input)
simulateSwap(pool, swap, signer)
```

`DirectPoolCollector` 已根据 registry 为每个池创建 adapter，并独立处理 quote、观察写入和退避。因此不能在 collector 或 executor 中新增 Orca 专用分支；仅在 factory 选择 `OrcaWhirlpoolAdapter`，并将模拟资格判断从“Raydium DEX ID”改为“经验证的 Solana observe-only adapter”。

| 位置 | 必须的变更                                                                                                                                                                              |
| --- |------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `package.json` / lockfile | 加入并锁定官方、兼容 `@solana/web3.js` v1 的 `@orca-so/whirlpools-sdk` 及其必需的 peer dependency。不得迁移本项目到新版 web3.js。                                                                              |
| `market-registry.yaml` | 增加 Orca DEX 定义和本设计锁定的单池 allowlist，默认可启用但永远 `observe_only`。                                                                                                                         |
| `src/trading/market-registry.ts` | 扩展 adapter/quote-source 联合类型和 schema 校验；Orca 仅允许 Solana、`whirlpool`、`local_math` 与有效 program ID。增加 Whirlpool 专属的已核验 fee rate/tick spacing 字段，禁止用 Raydium `expected_fee_tier` 语义冒充。 |
| `src/trading/pool-adapters.ts` | factory 增加 `OrcaWhirlpoolAdapter`；抽取或共享 Token-2022 mint 验证，新增 Orca 的 pool、vault、tick-array、报价、交易构造与模拟实现。                                                                           |
| `src/trading/direct-pool-collector.ts` | 让经注册且验证通过的 Orca observe-only Solana adapter 进入现有模拟闸门；原有额度、利润、冷却和 stale quote 规则不变。                                                                                                 |
| `src/main.ts` | 不把 Orca 交给当前只解析 Raydium Pool State 的固定池监听器；Orca Adapter 自行读取并验证池状态。 |
| `src/dashboard.ts` | 将 Orca DEX 显示为 `Orca Whirlpool`；模拟说明不再暗示所有记录都来自 Raydium。                                                                                                                           |
| 测试 | registry、adapter、Token-2022、collector 降级、交易构造/模拟与 UI 文案测试。                                                                                                                         |
| `docs/` | 更新当前架构/TODO 以列明 Orca 的已批准待实施范围；实现完成前本文保留在 `docs/`。                                                                                                                                 |

## 4. Registry 设计

新增 DEX 记录的概念形态如下；`expected_fee_rate` 和 `expected_tick_spacing` 必须先从链上 `ASAx…M5W2` 人工读取并复核后填入，禁止猜测数值：

```yaml
dexes:
  orca_whirlpool_solana:
    chain: solana
    adapter: orca_whirlpool
    quote_source: local_math
    program_id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"

pools:
  - id: xspcx-solana-orca-whirlpool-usdc
    enabled: true
    instrument_id: XSPCX
    chain: solana
    dex: orca_whirlpool_solana
    mode: observe_only
    reason: quote_asset_not_pinned
    verified: true
    address: "ASAxmEaTT1HFe3mVC3zbKDE4tuB28W7732XQrEMBM5W2"
    token_in_out:
      asset_address: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8"
      asset_decimals: 8
      quote_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      quote_decimals: 6
    expected_fee_rate: <verified on chain>
    expected_tick_spacing: <verified on chain>
```

Parser 要 fail closed：adapter、program、pool address、两枚 mint、decimals、fee rate、tick spacing 任一缺失或不符均拒绝启动该池。现有重复键检查应继续禁止同一 `(instrument, chain, address)` 多次登记，但允许 XSPCX 在同链登记 Raydium 与 Orca 两个不同地址。

## 5. OrcaWhirlpoolAdapter

### 5.1 SDK 与读取原则

使用官方 legacy `@orca-so/whirlpools-sdk`，原因是项目当前使用 `@solana/web3.js` v1；不手写 Whirlpool Borsh 布局、tick 数学或 swap 指令。所有 SDK API 使用必须以锁定版本真实类型为准，不能照抄未编译的示例。

Adapter 仅接受 registry 中 `orca_whirlpool` / Solana 组合。RPC endpoint 缺失、program 不一致、账户不存在、SDK 无法获得完整 tick array 时，抛出可记录的 quote/verification 错误，不选择其它池代替。

### 5.2 启动身份验证

`verify(pool)` 必须在首次使用以及 collector 重建 adapter 后执行：

1. 检查 RPC 返回的链为 Solana mainnet；读取 `pool.address`，并验证账户 owner 精确等于 registry 的 Orca Whirlpool program。
2. 用 SDK 解码 Whirlpool，验证 `tokenMintA/B` 与 registry 两 mint（允许 pool 内顺序相反）、两 mint decimals、`feeRate`、`tickSpacing`。
3. 验证 token vault 地址和 owner/账户布局符合 decoded pool，不能只相信 pool 地址。
4. 读取两枚 mint 的 owner 和扩展；资产 mint 必须通过第 6 节的 Orca allowlist 策略，USDC 必须为预期传统 SPL mint/program。
5. 任一身份失配抛出 `PoolIdentityMismatchError`，由既有 collector 标为人工修复后才可恢复；普通 RPC 短暂故障走已有退避。

### 5.3 Exact-in quote 与状态指纹

`quoteExactIn` 应：

1. 根据 `asset_to_quote` 或 `quote_to_asset` 映射为 Whirlpool 的 A→B/B→A，输入为原始 raw 整数，不经 UI amount 四舍五入。
2. 读取 Whirlpool、当前和可能跨越的 tick arrays，用官方 SDK 计算 fixed-amount exact-in quote；若 tick array 缺失或跨 tick 读取不完整则失败关闭。
3. 返回实际 `amountOutRaw`、由现有 `slippageBps` 计算的 `minimumAmountOutRaw`、价格影响和 raw SDK 诊断信息。
4. 将 pool 的价格/流动性/tick/current index、实际参与报价的 tick-array 地址及其 account data hash 共同纳入 `stateFingerprint`；记录读取完成 slot。slot 只是完成标记，不代表多次 RPC 读取是原子快照。
5. `buildSwap` 与 `simulateSwap` 前重新读同一组状态并比对 fingerprint；不一致则废弃报价并重新扫描，绝不模拟旧 quote。

### 5.4 交易构造与模拟

`buildSwap` 只允许 `simulationOnly: true`：重新验证指纹，使用 Whirlpool SDK 生成精确方向、输入额、`minimumAmountOutRaw` 和必要 tick arrays 的 swap transaction。接收者为现有模拟 signer，账户创建/ATA 的处理仅限 SDK 所需、不会广播的指令。

`simulateSwap` 使用项目已有 RPC 日志封装与 signer 对交易签名，调用 `simulateTransaction`。应保留模拟日志、compute units、网络费、实际 input debit/output credit；若 RPC 不返回可可靠解析的余额差，模拟应为失败/跳过而非声称成功。

## 6. Token-2022 安全策略

XSPCX 是 Token-2022。现有 Raydium 的审查例外不能隐式套用到 Orca，因此需把此**精确 pool/program/mint 组合**加入 reviewed observe-only allowlist；不能按 instrument 或 mint 全局开放。

Orca 检查与当前 Raydium 检查等价：

- 只允许已审查的 metadata、permanent delegate、default account state、scaled UI amount、未暂停 pausable、无活动程序的 transfer hook 与当前 confidential-transfer 配置；
- 拒绝 transfer fee、活动 transfer hook、暂停 mint、非 initialized 默认账户状态、未知扩展、异常或非正的 scaled UI multiplier；
- 所有 raw quote、minimum output、模拟输入/输出保持链上 raw 数量；仅 CEX 份额与 Dashboard 展示使用有效期内的 UI multiplier；
- 缺失 Clock/mint 或 multiplier 到期/无效时失败关闭。

共享验证函数的输入必须包含 protocol、pool ID、program ID、asset mint、quote mint 和 `mode`，以防新池绕过白名单。注释应保留已有 `shortcut:` 格式，明确这是逐池审查、未来扩展须重新验证。

## 7. 采集、记录与故障语义

对同一 XSPCX 和观察规模，Raydium 与 Orca 各自拥有 quote、state fingerprint、scan/失败记录和 30 秒模拟冷却键。两者不共享报价，也不以其中一个的健康状态判断另一个。

现有 CEX VWAP、USDC/USDT `ASSUMED_1_TO_1` 估值、固定 gas budget、1% net margin、报价 freshness 和 `NOT_EXECUTABLE` 决策口径不变。Orca quote 成功不表示可成交或可赎回；它仅是另一份可审计的观察。

| 情形 | 行为 |
| --- | --- |
| Orca 身份/mint/扩展失配 | Orca 置为身份错误，停止该池；人工修 registry/re-arm 后恢复。 |
| Orca RPC/SDK/tick-array 暂时失败 | 记录失败，按既有指数退避重试；Raydium 不受影响。 |
| Orca 报价 stale 或状态指纹变化 | 跳过模拟，重新报价。 |
| Orca 无利润、高价格影响、无 signer/余额 | 写明既有阻断码或模拟跳过码，保持 `NOT_EXECUTABLE`。 |
| Orca 模拟成功 | 保存结果；不得发送交易、不得提升模式。 |

## 8. 测试与验收

实施必须至少补齐：

1. registry fixture：合法 Orca 定义可解析；未知 adapter/quote source、非 Solana、错误 program/address、缺失或错误 fee/tick spacing 均 fail closed；现有 Raydium fixture 继续通过。
2. adapter unit test：正确创建 Orca adapter；pool owner、mints、decimals、fee、tick spacing、vault、Token-2022 extension 任一失配均拒绝。
3. quote test：两个方向正确映射；跨 tick；缺 tick array；slippage minimum output；fingerprint 在 Whirlpool 或 tick array 改变后失效。
4. transaction test：仅允许 `simulationOnly`，构造包含正确方向、mint accounts、vault、tick arrays 与 minimum output；非 simulation-only 请求拒绝。
5. simulation test：成功时解析余额/费用；RPC program error、无 signer、解析不足和网络错误分别成为失败/跳过，绝不广播。
6. collector regression：Orca 单池失败不阻断 Raydium；两者分别写入记录；Orca 可进入与 Raydium 相同的 observe-only 模拟资格闸门。
7. dashboard test：DEX 显示为 Orca Whirlpool，模拟说明保持协议中立，`NOT_EXECUTABLE` 清晰可见。
8. 手工 RPC smoke test：在已审核 endpoint 读取该固定池、核对第 1 节身份值和已登记 fee/tick spacing，完成两个方向 quote；若配置了隔离模拟钱包，再完成一次不广播模拟。

验收通过也不授权真实执行。任何后续执行必须先满足 [Direct Pool 实盘执行规划](../DIRECT_POOL_LIVE_EXECUTION.md) 所列前置条件并进行单独安全审核。

## 9. 实施顺序与回滚

1. 锁定 SDK 并在最小 probe 中验证实际 API/peer dependency。
2. 扩展 registry 类型、parser、fixture 和 Orca DEX/pool 登记；先保持 Orca `enabled: false`，直至手工 RPC identity 核验完成。
3. 实现 adapter 的 verify、Token-2022 策略与 quote，完成 unit tests。
4. 增加 unsigned simulation，泛化 collector 的 Solana observe-only 模拟资格，并完成回归测试。
5. 更新 dashboard 文案、运行 typecheck/测试与 RPC smoke test；再由人工将 Orca pool `enabled: true`。

回滚只需将该 pool 的 `enabled` 设为 `false` 并重启 collector；不删除历史 Direct Pool 记录，不改动 Raydium 设置，不自动切换到其它 Orca 池。

## 10. 非目标与风险

- 本设计不实现真实 swap、CEX 对冲、库存、授权、补偿或再平衡。
- 新增 SDK 的版本/peer dependency 需要以 lockfile 和 TypeScript 编译验证；不得假设文档示例与当前导出一致。
- RPC 多账户读取不是原子快照，fingerprint 复核是防止陈旧 quote 被模拟的最低保护，不等于消除链上状态竞争。
- Token-2022/RWA 的法律、可转让性、赎回和地域合规性不由本观察服务判断；任何执行计划需另行审核。
