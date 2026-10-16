# Meteora DLMM SPCXx/USDC 接入设计

> 状态：代码实现与离线测试已完成，待主网手工验收。  
> 日期：2026-10-16  
> 范围：将一个固定的 Meteora DLMM SPCXx/USDC 池接入 direct-pool 观察、exact-in 报价和 Solana simulation-only 验证；同时将现有 Orca Whirlpool 的池状态订阅迁入 Adapter 边界。  
> 非目标：真实交易、自动选池、自动发现池、多跳路由、历史 swap 回放。

## 1. 已确认决策

| 项目 | 决策 |
| --- | --- |
| Meteora 池 | 仅接入 `5whNk71ua6aRtNKazDqEeAimmfzuX9epJcjh4isQKprn`。 |
| 币对 | `SPCXx` (`Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8`, 8 decimals) / USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 decimals)。 |
| 协议 | Meteora DLMM (`lb_clmm`) 主网程序 `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`。 |
| 模式 | `observe_only`，`reason: quote_asset_not_pinned`；USDC 不是 Solana 的 pinned quote USDT。永远不能成为 `trade_candidate`。 |
| 功能 | 主账户订阅、exact-in 本地报价、未签名 swap 构造、已签名 `simulateTransaction`。不发送、不确认、不广播交易。 |
| SDK | 使用官方 `@meteora-ag/dlmm` SDK；不手写 LbPair/BinArray 解码或 DLMM 数学。 |
| 精确输入 | 必须消费全部 `amountInRaw`。SDK 返回部分消耗时，本次报价失败关闭。 |
| Token-2022 | 仅此协议/程序/池/两 mint 的组合加入受审核 observe-only 白名单；不扩大任何通用 Token-2022 权限。 |
| 监听架构 | Meteora Adapter 自己订阅 `LbPair`；Orca Adapter 同时订阅其 Whirlpool 主账户。Raydium 保留专用 `PoolState` 监听。 |
| 断线 | 任意 Adapter 自管订阅断线立即不健康；重连后先 RPC 快照和身份校验，成功后触发重新报价。第一期不回放历史 swap。 |
| 测试 | CI 只跑无密钥、无主网依赖的单元测试。主网只读验证和模拟钱包验证是人工/环境验收。 |

## 2. 为什么 DLMM 不能当作 Raydium CLMM 配置项

Raydium CLMM 的固定池地址是 `PoolState`，报价要读取 tick arrays；Meteora DLMM 的固定池地址是 `LbPair`，报价要根据方向读取 bin arrays。两者都属于集中流动性模型，但账户 layout、状态字段、动态费和 swap 指令完全不同。

现有 `src/fixed-pools.ts` 的 Solana 分支虽然名为 `startSolanaPool`，实际上硬编码了 Raydium `PoolState` 的长度、Anchor discriminator 和字段偏移。因此：

1. 将它重命名为 `startRaydiumClmmPool`；
2. 不把 Meteora 或 Orca 解码逻辑塞进去；
3. 每个协议由自己的 `PoolAdapter` 订阅并验证主账户；
4. 账户变更只用于触发重新报价，绝不把主账户边际价当成固定金额的成交价。

## 3. 链上身份与注册表

在 `market-registry.yaml` 新增 DEX 与池：

```yaml
dexes:
  meteora_dlmm_solana:
    chain: solana
    adapter: meteora_dlmm
    quote_source: local_math
    enabled: true
    program_id: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"

pools:
  - id: xspcx-solana-meteora-dlmm-usdc
    enabled: true
    instrument_id: XSPCX
    chain: solana
    dex: meteora_dlmm_solana
    mode: observe_only
    reason: quote_asset_not_pinned
    verified: true
    address: "5whNk71ua6aRtNKazDqEeAimmfzuX9epJcjh4isQKprn"
    token_in_out:
      asset_address: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8"
      asset_decimals: 8
      quote_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      quote_decimals: 6
    expected_bin_step: 8
```

`market-registry.ts` 必须：

- 把 `meteora_dlmm` 加入 `RegisteredDex.adapter`；
- 将它限制为 `solana + local_math + program_id`；
- 引入 `expected_bin_step?: number`，且仅允许 DLMM 池使用；
- 为固定 Meteora 池建立类似 `ORCA_XSPCX_USDC_POOL` 的不可漂移常量；
- 拒绝池 ID、程序、地址、mints、decimal、模式、reason、`verified` 或 `expected_bin_step` 与固定常量不一致的注册表；
- 保持 `solveDirectPoolCandidates` 不变：该池是 observe-only，结果中必须永远没有它。

运行时 `verify` 还必须从主网读取并检查：

1. 账户 owner 等于锁定的 Meteora DLMM Program ID；
2. LbPair 的 token X/Y 恰为上列两个 mint（允许链上顺序与 asset/quote 配置顺序不同）；
3. 两 mint decimals 与配置一致；
4. `binStep === 8`；
5. 两个 mint 的 Token Program 和扩展均通过第 6 节的受限检查。

任何身份失配抛出 `PoolIdentityMismatchError`，直到人工修复注册表并重启/re-arm 前不得自动恢复。

## 4. Adapter 级状态订阅

### 4.1 接口

在 `PoolAdapter` 增加可选或统一的订阅能力。建议以一个与协议无关的最小回调契约实现，避免把 `PoolMonitorState` 反向导入 Adapter：

```ts
type AdapterPoolState = {
  slot: bigint;
  observedAt: number;
  stateFingerprint: string;
  marginalPrice?: string;
};

type PoolWatchCallbacks = {
  onState: (state: AdapterPoolState) => void;
  onUnavailable: (reason: string) => void;
};

interface PoolAdapter {
  // Existing methods omitted.
  watch?(pool: RegisteredPool, callbacks: PoolWatchCallbacks): Promise<() => Promise<void>>;
}
```

具体命名可调整，但必须满足下列行为：

- `DirectPoolCollector` 或其调用方在启动时为所有 adapter-owned observe-only 池启动一次 watch；
- 收到 `onState` 后使用现有 `coalesceWindowMs` 调用 `markDirty(instId, chainIndex)`；
- `onUnavailable` 使该池不可报价；不得继续使用上一次 quote；
- shutdown 必须等待所有 stop 函数；
- 回调不可直接进行 quote，仍由 250ms 的 `runDue()` 调度统一执行。

Adapter 状态可通过现有 health 与 Dashboard 表现；第一期不要求把 DLMM/Orca 主账户状态写进 Raydium 专用 `dex_pool_event` 历史表。

### 4.2 Meteora DLMM watch

`MeteoraDlmmAdapter.watch`：

1. 用 Solana WebSocket `onAccountChange` 订阅固定 LbPair 地址，`confirmed` commitment；
2. 每个事件先检查账户 owner、最小 layout 和可读取性；以账户 data hash + slot 生成 state fingerprint；
3. 刷新 SDK 实例/状态，读取 active bin 得到仅供观察的 marginal price；
4. 成功后回调 `onState`；
5. WebSocket 错误、关闭、身份失配或 RPC snapshot 失败时回调 `onUnavailable`；
6. 以指数退避重连；重连成功必须重新 `verify` 并主动发一个新状态事件；
7. 不订阅或反放历史 swap transaction，也不把订阅事件解释为逐笔成交。

### 4.3 Orca 迁移

当前 `main.ts` 已把 `orca_whirlpool` 排除在 `startFixedPoolMonitors` 外。保留这个排除，但为 `OrcaWhirlpoolAdapter` 实现同一 `watch`：

- 订阅 Whirlpool 主账户 `ASAxmEaTT1HFe3mVC3zbKDE4tuB28W7732XQrEMBM5W2`；
- 读取/校验 Whirlpool data、program、mints、fee rate 和 tick spacing；
- 主账户变化触发 coalesced quote；
- quote 时仍使用 Orca SDK 获取方向所需 tick arrays；
- 连接状态、重试和 fail-closed 行为与 Meteora 一致。

这解决当前 Orca 只靠 CEX book 更新触发报价的问题，但不改变其 `observe_only` 身份。

## 5. Meteora exact-in quote、构造和模拟

### 5.1 Quote

`MeteoraDlmmAdapter.quoteExactIn` 使用官方 SDK 的等价流程：

1. `DLMM.create(connection, new PublicKey(pool.address), { cluster: "mainnet-beta" })`；
2. 读取已验证的 LbPair，并确定 `asset_to_quote` / `quote_to_asset` 对应的 `swapYtoX`；不得根据 token symbol 猜测；
3. `getBinArrayForSwap(direction, ...)` 获取 swap 所需的 bin arrays；
4. 调用 `swapQuote(amountIn, direction, slippageBps, binArrays, ...)`；
5. 若 `consumedInAmount !== input.amountInRaw`，抛出明确错误，例如 `Meteora DLMM exact-in quote is partial`；
6. 若 output/min output 非正，或任何 bin array/RPC 读取失败，报价失败；
7. `amountOutRaw` 使用 SDK quote 的实际输出；`minimumAmountOutRaw` 使用 SDK 的 slippage 结果；
8. `raw` 保存无敏感信息的 pool、active bin、bin array addresses、consumed input、output、minimum output、动态费和 slot 摘要；
9. 指纹至少包含 LbPair account data hash/active bin、所用 bin array address + account data hash、slot 和 input direction。构造或模拟前不一致必须 requote。

`priceImpactPercent` 必须来自同一 LbPair/active-bin 快照的边际价格与 exact-in output 的比较。其用途仅为 guardrail/展示；不替代 swap quote。

### 5.2 构造 unsigned swap

`buildSwap` 必须：

1. 调用 `assertExecutionInput(pool, input, "solana")`，因此 observe-only 只能在 `simulationOnly: true` 情况下继续；
2. 重新读取并校验 LbPair、mints、Token Program、状态 fingerprint 和 quote 使用的 bin arrays；任何变化均拒绝；
3. 使用 SDK 的 `swap` 构造 transaction，且只允许配置的 pool、input/output mint、调用钱包、`amountInRaw`、`minimumAmountOutRaw` 和 quote 的 bin arrays；
4. 不得设置发送、确认或签名以外的网络动作；
5. 复用现有 Solana transaction 序列化和 `mintTokenPrograms` 传递机制。

### 5.3 Simulation-only

复用 `simulateSolanaSwap`：

- 只有 `direct_pool_observation.simulation_enabled: true` 且 `SOLANA_SIMULATION_PRIVATE_KEY` 可用时尝试；
- 签名后调用 RPC `simulateTransaction`，绝不调用 `sendTransaction`；
- 没有 simulation key、SOL、输入 token 或 ATA 时，保留 quote 并记录 `skipped`，不是 quote 失败；
- 模拟成功不改变 `NOT_EXECUTABLE`，也不提升池为 `trade_candidate`。

## 6. Token-2022 安全边界

SPCXx 是 Token-2022 mint。修改 `src/trading/pool-adapters.ts` 时：

1. `token2022ObservationPools` 增加 Meteora 的精确条目；
2. `validateSolanaTokenSupport` 与 `isScopedToken2022Pool` 的协议联合类型加入 `meteora_dlmm`；
3. 条目必须同时匹配 `protocol`、pool ID、instrument ID、chain、mode、verified、pool address、program ID、asset mint 和 quote mint；
4. 沿用既有允许扩展集：无转账费、无启用 transfer hook、未暂停、无未知扩展；
5. 不因为新增条目而接受其他 Meteora 池、其他 Token-2022 mint 或可执行池。

## 7. 文件级实现清单

| 文件 | 必需改动 |
| --- | --- |
| `package.json` / lockfile | 添加官方 `@meteora-ag/dlmm` 及其 SDK 所需 peer dependency；锁定在 lockfile。不得添加非官方报价服务。 |
| `market-registry.yaml` | 新增固定 Meteora DEX 和 observe-only pool。 |
| `src/trading/market-registry.ts` | adapter/schema、DLMM pinned constant、`expected_bin_step` 校验与漂移拒绝。 |
| `src/trading/pool-adapters.ts` | `MeteoraDlmmAdapter`、factory 分发、DLMM Token-2022 白名单、quote/build/simulate、Adapter watch；为 Orca 添加 watch。 |
| `src/trading/direct-pool-collector.ts` | 启动/停止 adapter-owned watches、健康状态、池变更触发 dirty；DLMM/Orca 仅在自身 watch healthy 时报价。 |
| `src/main.ts` | 将 adapter watch 状态接到 health、coalesced collector 与优雅停止；仍把 Orca/Meteora 排除在 Raydium fixed monitor 输入之外。 |
| `src/fixed-pools.ts` | `startSolanaPool` 重命名为 `startRaydiumClmmPool`，相关错误文本同步。不得改动其 Raydium layout 解析语义。 |
| `src/config.ts` | 若 `FixedPoolConfig.dex` 仍只服务固定监控，应保持它不承载 Orca/Meteora；不要只为显示目的扩大为伪通用类型。 |
| `src/trading/market-registry.test.ts` | 固定 DLMM registry、错误的程序/地址/mint/bin step、observe-only 不进入候选、factory 创建正确 Adapter。 |
| `src/trading/pool-adapters.test.ts` | DLMM 白名单严格范围、输入方向映射、partial fill 被拒、watch 断线健康状态与 stop。SDK 网络调用必须 mock。 |
| `src/trading/direct-pool-collector*.test.ts` | pool account change 与 CEX book change 都走 coalesce；断线不报价；缺少 simulation signer 时模拟 skipped 但 quote 保存。 |
| `docs/DIRECT_POOL_ARCHITECTURE.md` / `docs/TODO.md` | 将已实现前的设计目标补充为 Meteora DLMM + Adapter watch；实现完成后更新进度。 |

## 8. 验收标准

### 8.1 自动化

1. registry 接受唯一正确的 Meteora 注册，拒绝任何锁定身份字段漂移；
2. Meteora 池永远不是 direct trade candidate；
3. `createPoolAdapter` 对该池返回 `MeteoraDlmmAdapter`；
4. Token-2022 例外无法被协议、program、pool、mint、模式或 `verified` 的任一篡改复用；
5. full input quote 可产生符合 `ExactInQuote` 的 raw 数值；partial input quote 必须失败；
6. 主账户 watch 变化只排程报价，不能直接把 marginal price 写为成交输出；
7. watch 断线或 snapshot 失败阻断新报价；重连并完成 verify/snapshot 后才恢复；
8. Orca 的同类 watch 通过相同健康与 stop 测试；
9. simulation-only transaction 永不调用广播 API；缺少 signer 的路径为 `skipped`。

### 8.2 手工主网验证（非 CI）

在设置 `SOLANA_RPC_URL` 与 `SOLANA_RPC_WS` 后：

1. `verify` 成功确认 owner、mints、decimals、bin step；
2. 两个方向各给一个小的正 input，确认 full exact-in quote、bin arrays 和状态指纹被记录；
3. 断开 WebSocket，确认健康状态不再允许 quote；恢复后观察重新快照与报价；
4. 设置专用且无生产权限的 `SOLANA_SIMULATION_PRIVATE_KEY` 与测试余额，确认仅有模拟 RPC，链上无已发送交易；
5. Dashboard/数据库显示 `NOT_EXECUTABLE` 和 `ASSUMED_1_TO_1`，不得出现可执行机会。

## 9. 明确不做

- 不将此池从 USDC 自动兑换为 pinned USDT；
- 不把动态 fee、active bin 或主账户边际价格作为可交易价格；
- 不在多个 SPCXx/USDC Meteora 池中比较或自动选最优池；
- 不把 DLMM 的 bin arrays 纳入 Raydium listener；
- 不广播、不授权、不转账、不补充库存；
- 不在本期补历史事件或构建通用跨协议账户解码框架。

## 10. 实现后文档归档

实现、自动化验收和主网手工验证均完成后，将本文移动到 `docs/archive/`，并在 `docs/archive/README.md` 写入文件名、完成状态和保留原因，遵守仓库的文档归档规则。
