# 待办事项

## X Layer 授权方案评估

- [ ] 评估授权不足时由程序自动签名并广播 `approve` 交易。可选无限额度（少发授权交易，但获批 spender 的权限更大）或按需有限额度（权限较小，但可能频繁上链；为兼容部分代币，改额度时可能要先归零，[ERC-20 标准](https://eips.ethereum.org/EIPS/eip-20)也建议客户端考虑此做法）。实施前需限定代币和 OKX API 当前返回的 spender，并等待授权上链确认后重新报价再兑换。
- [ ] 核验 AAPLx、USDT0 是否支持 ERC-2612 `permit`，以及 OKX 聚合兑换是否能在兑换流程中使用该签名。若两端都支持，可免去单独广播授权交易；目前不能假设这些代币或聚合器已支持。[ERC-2612 规范](https://eips.ethereum.org/EIPS/eip-2612)
- [x] 修正 `src/trading/prepare.ts` / `selectCall` 的授权 spender 来源：读取 OKX `approve-transaction` 返回值，并验证其中 approve calldata 指向相同 spender。

## 路线核验

- [ ] 启用 Solana 实盘路线前，核验当前 OKX 账户的 XAAPL 充值/提现路线及账户配置。

## 机会计算口径

- [x] 改用 Backed 官方 v2 multiplier 接口，校验 active/pending multiplier 与 activation timestamp；官方建议的激活前后 15 分钟窗口停报，超阈值变化仍需人工确认。[xStocks API 与 multiplier 指南](https://docs.xstocks.fi/developers/multipliers)

## 固定池监控后续阶段

- [ ] 只有在采集器与 Dashboard 需要跨进程共享高频最新盘口/池状态，或需要多实例协调时再评估 Redis；当前单实例使用进程内缓存、MySQL 保存历史报价与决策即可。
- [ ] 按目标规模持续验证 USDG、USDC、USDT 间的真实兑换/赎回成本与可用深度；当前观察收益按明确标注的 `USDG/USDC = 1 USDT` 假设计算，不代表可成交 USDT 收益。2026-10-14 的一次 X Layer QuoterV2 抽查确认 USDT0/USDG、USDT0/USDC、USDG/USDC 三个 0.01% 池存在且 $100/$500 Exact-In 可报价，但不是持续成本模型。
- [ ] 将固定 Gas 预算替换为实时 OKB/SOL 价格折算与链上交易费估算；当前预算为 X Layer 两方向各 0.05 USDT（Wrapper + Swap），Solana 每次 Swap 0.01 USDT。替换时保留预算值与实际估算的来源、时间和差异记录。
- [ ] 如后续需要逐笔 swap 审计或回测，将原始池事件归档到适合高频写入的存储；MySQL 当前只保留按池采样的状态历史。
- [ ] 若固定池数量增长或历史分析负载明显增加，再评估按分钟/小时聚合或分区；当前每池最多每 10 秒采样并保留 7 天。
- [x] 实现 X Layer QuoterV2 固定金额 `Exact-In`，结果携带 block/hash 与池状态指纹；报价使用指定 token 对和 fee tier。
- [x] 实现 Raydium CLMM SDK 逐 Tick 固定金额 `Exact-In`；报价保存读取完成时的 slot 和状态指纹，构建/模拟时复核指纹；仅为已登记的 XNVDA observe-only 池按扩展白名单开放 Token-2022 报价，并将链上生效的 Scaled UI multiplier 用于收益比较，raw 报价仍按链上数量保存。
- [ ] 将 Raydium Pool State、配置、bitmap 和 Tick Array 改为单一 RPC context 校验；当前 SDK 多次 RPC 读取期间 slot 会正常推进，因此 slot 仅作读取完成标记，报价/构建/模拟通过状态指纹检查变化。
- [x] 在 `direct_pool` 模式观察已登记的 `observe_only` 池：记录 raw Exact-In、状态版本、同规模 CEX VWAP、毛收益、CEX 手续费、固定 Gas 预算、正负观察净收益与 ROI；X Layer 只读校验 ERC-4626 `asset()` 并调用 `previewDeposit` / `previewRedeem` 换算；结果写入独立决策表且保持 `NOT_EXECUTABLE`。
- [ ] 对两链 exact-in 与独立链上只读报价执行同池、同规模交叉验证；目前没有活跃的资产/固定报价币候选，Solana Raydium 稳定币池发现结果也尚未与本地 CLMM 数学报价完成对账。完成前观察收益保持 1:1 假设标签，不作为可实现净收益，数据不写入旧 Aggregator `quote_observation` / `opportunity` 表。
- [x] 固定池决策写入独立 direct-pool 表并固定为 `NOT_EXECUTABLE`；两链 unsigned swap 构造和不广播模拟接口已实现。

## 指定池架构后续阶段

- [ ] 人工核验并登记有活跃流动性的候选直接池及其真实地址、token/mint、精度、报价币和协议端点。2026-10-14 链上查询发现 XNVDA/USDT0 Uniswap V3 fee 100/500 池地址分别为 `0x20f9ee5455d5cbdab8b310de8c7968858a067f4c`、`0x66d18056c9ce5e9164a2f7fe92d30072ec5201b1`，两池当前 `liquidity() = 0`；XAAPL/XSPCX 在 fee 100/500/3000/10000 未发现池。Raydium 官方 CLMM 池 API 对 XAAPL/XSPCX/XNVDA-USDT 返回 0 个候选。当前不登记 `trade_candidate`，保持观察池/`not_configured`，待有活跃池后重新核验。
- [ ] 若需扩大 Token-2022 支持范围，先逐扩展类型核验 Raydium 数学报价及真实转账语义；其他 Token-2022 mint、未知扩展与所有 Token-2022 执行仍被拒绝。
- [ ] 若以后执行包装资产池，实现并核验 ERC-4626 deposit/redeem unsigned transaction、授权、实际费用和失败补偿；当前只实现只读 `asset()` / preview 换算，包装池继续 `observe_only` 且理由为 `wrapper_required`。
- [ ] 需要支持 Orca、Sushi 或其他 DEX 时，按 `PoolAdapter` 的 verify/watch/quoteExactIn/buildSwap/simulateSwap 契约逐协议接入；不得在 Collector/Executor 中直接新增协议分支。
- [ ] 如需自动充值、提币、跨链、补货或再平衡，作为指定池实时套利之外的独立结算系统设计和审核；第一期仅使用预置库存。
- [ ] 对已人工审核的两链交易候选执行真实 build/simulate RPC smoke test；当前没有候选池和公开模拟钱包，`NOT_EXECUTABLE` 保持不变。
- [x] 实现独立的 `aggregator_shadow` 记录和 `/direct-pools` 对照展示；按路线合并异步工作，不阻塞或替代 direct-pool 决策。
