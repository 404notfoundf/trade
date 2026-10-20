# Solana Raydium 模拟成本收益实现方案

## 状态

待实现。本文只定义 SPCXx/USDC 等 Solana Raydium `observe_only` 池的收益展示口径；不改变其 `NOT_EXECUTABLE` 边界，也不授权广播交易。

## 背景

当前 Direct Pool 报价净收益将 Solana 每笔签名的 5,000 lamports 基础费按 OKX SOL-USDT 中间价估算；价格缓存 30 秒，超过 60 秒则视为不可用。估算不含优先费或 ATA 租金；价格不可用时仍保存报价，但不计算净收益。`solana_swap_gas_usdt` 保留在配置结构中，不再用于观察 Gas 估算：

```text
报价净收益 = 毛收益 - CEX 手续费 - 估算的单签名基础费
```

Raydium 模拟已能取得 transaction message 的 lamports 费用、模拟消耗的计算单元及 token 余额变化，但这些数据没有折算为 USDT 或进入独立模拟净收益。当前报价层的基础费估算仍不代表某个已模拟交易的实际链上成本。

## 已确认的决策

1. 保留现有 `net_profit_usdt`、`roi` 和 `gas_budget_usdt` 的含义：它们始终是报价层估算，不混入逐笔模拟成本；Solana 使用单签名基础费估算，X Layer 继续使用配置的固定预算。
2. 新增独立的模拟成本/收益字段；绝不以模拟结果覆盖报价收益，避免同一统计口径混入已模拟和未模拟记录。
3. SOL 价格只使用现有 OKX index 机制；不引入额外 RPC 或第三方价格源。价格缺失、过期或不可信时，模拟可通过，但模拟收益不得计算。
4. 输出 ATA 确实由该交易创建时，其实际租金作为一次性成本全额计入该条模拟收益；已存在 ATA 的租金为零。
5. 观察阶段不主动假设或添加 priority fee。仅计入构造并模拟的 message 已包含的费用；未来实盘执行另行设计动态 priority fee。
6. 维持当前模拟节流：只有盘口、价格影响等基础条件满足，且报价层估算净边际达到 1% 时才触发模拟。
7. 总览、正收益窗口和现有正收益筛选继续以报价净收益计算。模拟净收益仅在报价详情与收益明细中展示。
8. 历史记录不回填：缺少当时的模拟钱包状态、transaction message 和 SOL 价格，回填会制造伪精度。

## 目标数据模型

在 `direct_pool_decision` 增加可空字段：

| 字段 | 含义 |
| --- | --- |
| `simulation_transaction_fee_native_raw` | `getFeeForMessage` 给出的 lamports 费用。 |
| `simulation_ata_rent_native_raw` | 本次模拟创建输出 ATA 时实际存入该账户的 lamports；否则为 `0`。 |
| `simulation_network_fee_usdt` | 上述两项 lamports 按新鲜 SOL/USDT 指数折算后的总成本。 |
| `simulation_ata_rent_usdt` | ATA 一次性租金的 USDT 折算值。 |
| `simulation_net_profit_usdt` | `gross_profit_usdt - cex_fee_usdt - simulation_network_fee_usdt`。 |
| `simulation_roi` | `simulation_net_profit_usdt / 原报价口径 invested`。 |
| `simulation_valuation_status` | `VERIFIED`、`UNKNOWN` 或 `NOT_APPLICABLE`。 |
| `simulation_valuation_reason` | 价格不可用、价格过期或其他不能得出模拟收益的原因。 |

现有 `simulation_network_fee_native_raw` 可以保留作兼容展示，但新字段应以更精确的名称区分 transaction fee 与 ATA 租金。

## 实现步骤

### 1. 修正模拟路由判定

`RegisteredPool.dex` 保存的是 registry DEX ID（当前为 `raydium_clmm_solana`），不是固定池展示名 `raydium-clmm`。模拟资格应依据 registry adapter 为 `raydium_clmm`，或至少使用正确的 registry DEX ID；否则 SPCXx 池永远停在 `NOT_APPLICABLE`。

### 2. 从模拟结果取得真实 native 成本

在 `raydium-simulator.ts`：

- 将 `getFeeForMessage` 的结果作为 transaction fee 返回；该值对应当前 message，包含 message 已设置的 priority fee。
- 模拟前记录输出 ATA 是否存在；若原本不存在且模拟后账户存在，读取模拟后该账户的 lamports，作为实际 ATA rent。
- 继续校验实际输入扣款等于 exact-in 输入、实际输出不低于最小输出。费用采集不能放松这两个校验。

不得用 `unitsConsumed` 推导费用：priority fee 由 message 的 compute budget 配置决定，且在 Solana 上按请求的计算预算收费。

### 3. 扩展现有 OKX 指数缓存

- 将 Solana 的 SOL（或 OKX 所支持的对应 Solana 原生/包装 SOL 标识）加入现有 `INDEX_TARGETS`。
- 复用现有时间戳、正数、地址匹配和最大年龄校验。
- 提供只读 helper，将 lamports 折算为 USDT：`lamports / 1e9 * SOL/USD / USDT/USD`。
- 当 SOL 或 USDT 价格不新鲜、不可用或稳定币保护未通过时，返回 `UNKNOWN` 和明确原因，不回退到固定 Gas 值。

### 4. 写入独立模拟收益

`recordObserveDecision` 在模拟结束后：

- 无论模拟估值是否可算，原报价净收益保持原逻辑不变；
- 仅在模拟成功且成本折算 `VERIFIED` 时写入模拟成本、模拟净收益和模拟 ROI；
- 模拟失败、跳过或价格不可用时，保存可得的 raw 成本与状态/原因，但所有模拟 USDT 收益字段为 `NULL`；
- `valuationInputs` 记录 SOL/USDT、USDT/USD 的来源时间与费率，便于审计。

### 5. 展示与迁移

- 新增顺序迁移文件，只 `ADD COLUMN`，不更新历史行。
- 报价详情显示：交易费 lamports、ATA rent lamports、模拟成本 USDT、模拟净收益/ROI、估值状态与原因。
- 收益明细显示报价净收益和模拟净收益两列；模拟字段为空时显示“未估算”。
- 总览、窗口和正收益筛选继续只使用 `net_profit_usdt`。

## 验收标准

1. `xspcx-solana-raydium-usdc-clmm` 在开启模拟后可进入模拟分支，不再因 DEX 标识不匹配而固定显示 `NOT_APPLICABLE`。
2. 已有输出 ATA 的成功模拟：ATA rent 为零，模拟网络成本等于 message fee 的 SOL/USDT 折算。
3. 缺失输出 ATA 且模拟创建账户：租金单独记录，并被全额计入该次模拟成本。
4. SOL 或 USDT 指数缺失/过期：报价净收益仍保留；模拟净收益、ROI 为 `NULL`，原因可见。
5. 模拟失败、跳过和冷却：不生成模拟 USDT 收益，也不改变报价净收益。
6. 现有总览、正收益窗口、筛选统计在新字段加入后结果不变。
7. 单元测试覆盖 DEX ID 路由、费用折算、ATA 有无、价格过期和持久化字段；`npm run typecheck` 与测试套件通过。

## 明确不做

- 不将 observe-only 池改为可执行路线，不广播交易。
- 不增加第三方价格源或对价格缺失进行静默回退。
- 不为观察模式猜测未来执行的动态 priority fee。
- 不回填旧记录，不将重复采样的观察净收益累加为实际利润。

## 风险与后续

模拟成本仍是临近报价时的估算：SOL 价格、账户是否已创建、priority fee 与池状态均可能在执行前变化。未来若开放实盘，应在构造最终交易后设置 compute budget、重新估费、重新估值，并以该次最终净收益通过执行门槛。
