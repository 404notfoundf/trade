# ArbBridge 深度对标扫描：当前项目的可借鉴边界与落地顺序

日期：2026-10-17
状态：对标与实施跟踪；“持久化执行意图与重启恢复”已实现，其余建议仍待后续评估
范围：静态比对 `D:\go\working\staking_service\arb\ArbBridge\ArbBridge` 与本仓库的报价、执行、风险、数据、运维和测试代码。未读取密钥内容，未连接数据库、RPC 或交易所，也未发单。

本文补充已有的 [全项目审查](ARBBRIDGE_PROJECT_WIDE_REVIEW.md) 与[收益核算参考](ARBBRIDGE_PROFIT_CALCULATION_LESSONS.md)：前两者聚焦估值、收益和 Direct Pool 路线；本文聚焦把观察/模拟/执行做成可安全运行和可证伪系统的工程机制。

## 结论

ArbBridge 最值得借鉴的不是语言、Redis 或其多进程目录结构，而是它把“有一个正价差”与“可以安全执行、能够证明发生过什么、异常后不会扩大敞口”之间的步骤显式化：

```text
配置与能力自检 → 数据新鲜度/风险闸门 → 决策与可复算输入
→ 写入执行意图 → 单腿提交/确认 → 对冲 → 对账、PnL 与告警
                                      ↘ 失败：停止新周期并恢复/人工处置
```

当前项目已经实现了这条链的一部分，且有不应退让的防线：协议 Adapter 隔离、池身份验证、池状态指纹、Direct Pool 的 fail-closed 观察模式、`Decimal` 金额运算、交易前后盘口重验、`trade_cycle` 状态、数据库命名锁、`HEDGE_REQUIRED` 人工对账、`SIGINT`/`SIGTERM` 优雅退出。尤其是 Solana 交易在广播前验证路由、指令白名单、模拟后的资产变化和费用上限；这些比照搬 ArbBridge 的通用框架更重要。

因此建议采用“小而完整”的路线：先补齐执行闭环和可复算性，再决定是否拆进程或加入 Redis。当前配置仍关闭交易，Direct Pool 候选又受报价币估值状态阻断；在这些前提没有变化前，不应提前建设实时集群或复杂仓储。

## 对比基线

| 维度 | 当前项目的事实 | ArbBridge 的成熟做法 | 结论 |
| --- | --- | --- | --- |
| 场所/协议接入 | TypeScript 单进程；OKX、X Layer、Solana；Direct Pool 协议适配器已分离 | Go 分层；CEX/链/DEX 端口与具体 Adapter 分离 | 保留当前 Adapter 边界；无需迁移语言或全盘端口化。 |
| 报价与收益 | `profit-calculation.ts` 已统一纯核算；估值状态区分；Direct Pool 当前固定不可执行 | `pricing` 纯函数合并盘口和 AMM，策略消费结果 | 继续补调用方与历史复算，不复制其单次 DEX RFQ 近似。 |
| 启动准入 | 启动中初始化 DB、验证池/路由，交易前检查签名者及 allowance | 配置、独占锁、DB/Redis、注册表、场所规则、崩溃恢复、行情就绪按顺序失败即退出 | 应为将来的执行模式增加一份明确的 preflight 报告；不必现在引 Redis。 |
| 行情/状态 | OKX book 新鲜度检查；固定池或 Adapter watch；池版本、区块/slot、指纹已记录 | 本地簿、陈旧度看门狗、原始帧录制和回放语料 | 最优先补“输入快照可回放”；不要把观察利润当成交利润。 |
| 执行失败 | 已有交易周期、数据库锁、链上确认、`HEDGE_REQUIRED` 与人工确认页 | 写前 intent、幂等键、失败矩阵、启动恢复后才 ready | 应补持久化 intent 与重启恢复，避免只依赖内存流程。 |
| 风控 | 路由状态、库存、盘口、滑点、费用/乘数、签名与交易模拟检查 | 分层 gate、限额、熔断、持久化急停、风险原因指标 | 执行启用前补最小全局急停和结构化拒绝原因；不应照搬证券公司行为日历。 |
| 账本/对账 | `trade_cycle`、链交易记录、成交后估算、人工 reconciliation | 库存预留、复式账本、三方对账和 PnL 归因 | 当前规模先做“每周期事实对账”，之后才考虑完整复式账本。 |
| 运维/测试 | 健康状态写库并展示；迁移脚本；多个 `node:test` 文件；无统一 `test` 脚本 | metrics/alarm、部署前检查、录制回放、单元/集成/故障测试与统一 `make check` | 最低成本收益是统一质量入口、回放夹具与故障矩阵。 |

## 可直接借鉴的项目

### P0：执行前置检查应成为可保存的放行结论

**借鉴点：** ArbBridge 的 trader 只有在配置、独占性、数据库、资产/场所能力、恢复和非陈旧行情均通过后，才进入可交易状态；每一步失败都不能悄悄降级成“看似正常”。

**当前基础：** `src/main.ts` 会配置路由、健康状态、DB 与行情；`src/trading/executor.ts` 在每笔周期中重新检查库存、盘口、费率、倍率、余额和 allowance。只是这些结果主要散在启动日志与单笔控制流里，尚无一份可供操作者审核的、版本化的放行报告。

**最小落地：** 仅在未来打开任一交易路线前，增加一个只读 preflight：输出并持久化配置版本、启用路线、钱包/交易所余额可用性、池身份与状态版本、盘口年龄、报价币估值状态、手续费/网络费来源和阻断原因。任何未知或过期项均拒绝 arm。

**验收：** 给定一次报告，操作者能回答“为什么能 arm / 为什么不能 arm”，且不会看到私钥、API key 或完整敏感响应。先覆盖现有 X Layer/Solana 路线，不做通用插件框架。

### P0：持久化执行意图与重启恢复

**借鉴点：** ArbBridge 在不可逆操作前写 intent；启动时查询“有 intent、无结果”的记录，必须向场所查询真实状态，不允许猜测或盲目重发。

**当前基础：** 本项目已在 `trade_cycle`/`trade_cycle_tx` 中记录周期和链交易，广播失败后会把链交易标为 `UNCERTAIN`，并在 `HEDGE_REQUIRED` 时禁止新周期。这是正确方向。

**缺口和风险：** 进程在“构造/签名/提交”之间退出时，现有启动路径没有明确的恢复阶段；仅凭内存变量无法判断订单是否已被 OKX 接收、链交易是否已进入 mempool/确认。重新发送可能造成重复成交，忽略又可能遗留裸敞口。

**最小落地：** 不重写执行器。为每个外部副作用增加不可变 intent（客户端订单号、预期资产方向、报价/状态版本、事务哈希或可查询标识、阶段时间），启动时先枚举未终态记录；逐项查询 OKX 订单和链状态，更新为已完成、需对冲或需人工对账。恢复清空前，自动执行保持 disarm。

**验收：** 用可控 fake 覆盖“写 intent 后退出”“广播请求超时但实际成功”“DEX 成功而 CEX 对冲失败”“重启后不重复发送”四种场景。

**实施状态（2026-10-17）：** 已按相同的 intent → 外部状态查询 → fail-closed 决策模式落地，不是照搬 ArbBridge 的存储或进程结构。迁移 `017_trade_cycle_recovery.sql` 增加执行快照、CEX 精确下单意图/结果、链上实际 delta 和恢复时间。启动与手动 arm 前均扫描未终态周期；只有确认的链上 swap delta 与提交对冲前记录完全一致，且 OKX IOC 完全匹配并全额成交，才可自动完成。缺订单、状态未知、链上 delta/订单参数不一致及部分成交均不重发，保持 disarm 并转恢复或人工对账。可控 fake 覆盖 intent 后退出、已确认广播、部分 CEX 成交和订单缺失四类路径。运行说明见 [TRADING_EXECUTION.md](TRADING_EXECUTION.md)。

**边界：** OKX 的 `clOrdId` 历史唯一性不保证，当前委托详情仅返回最新匹配；恢复因此核对 intent 时间、币对、方向、数量和限价，并查历史。已完成订单历史覆盖近 7 天/近 3 个月，但未完成后被取消的订单只保留 2 小时；若宕机过久导致订单不可查，系统不猜测成交结果，保持 `RECOVERY_REQUIRED` 并转人工处理。[OKX API 文档](https://www.okx.com/docs-v5/en/)

### P0：把每次决策固定为可复算快照

**借鉴点：** ArbBridge 将原始行情录制与离线 replay 视作策略结论的证据，而非调试附件。

**当前基础：** `scan_id`、Exact-In 原始数量、CEX VWAP、池版本/slot/指纹、估值状态及成本拆项已经分别保存。此前审查已指出 sizing 盘口与 valuation 盘口可能不是同一快照。

**最小落地：** 在 `direct_pool_decision` 的记录中区分并保存 sizing/valuation 两份 CEX 快照（时间、seq、使用档位摘要、资产量），并记录两者与 DEX quote 的时间差；超过阈值时不产生可比较利润。抽取少量脱敏 NDJSON/JSON fixture，以同一纯核算函数回放。

**验收：** 单条决策无需网络即可复算出方向、毛利、每项成本、净利和 ROI；缺一项输入时明确返回不可复算，不以零补齐。

### P1：结构化风险原因、可观测性与急停

**借鉴点：** ArbBridge 将风险 gate、circuit breaker、killswitch 和指标作为业务路径的一部分，并以稳定 reason code 支持告警和统计。

**当前基础：** `risk_event`、健康事件、`recordBlockedObservation`、route 状态和页面 arm/disarm 已存在；`executor.ts` 在发现异常周期后会暂停后续交易。Direct Pool 也保留了如 `QUOTE_VALUATION_UNKNOWN`、`CEX_DEPTH_INSUFFICIENT` 等原因。

**最小落地：** 统一执行与观察侧的有限 reason-code 词表；增加一个数据库持久化的全局“禁止新周期”开关，默认关闭。进程开始每个周期和关键外部提交前重新读取；只阻止新周期，不中断已提交链上腿的对冲和对账。

**验收：** 人工关闭后，新的 cycle 不创建；正在进行的 cycle 仍完成或进入 `HEDGE_REQUIRED`；Dashboard 能显示开关来源、时间和最后一个阻断原因。不要把“关闭开关”实现为强杀进程。

### P1：从固定规模观察升级到证据驱动的规模选择

**借鉴点：** ArbBridge 将 CEX 逐档深度、成本地板和候选规模求解放在纯定价层，策略只消费可解释的候选结果。

**当前基础：** 当前项目按 `observationSizesUsdt` 轮换规模，使用实际 CEX 档位与 DEX Exact-In；收益算术已有共享纯函数。

**适配边界：** ArbBridge 对 DEX 使用一次 Quoter 结果折算 RFQ 单档价格，不能直接用于 CLMM、Whirlpool 和 DLMM 的多规模曲线；直接搬入会产生不对称的滑点误差。

**最小落地：** 在 P0 快照可靠后，以现有几个观察规模离线复算净利曲线；仅为排名靠前的少数规模再次 Exact-In 报价，选择已扣成本后的最优可执行规模。对每个被拒绝规模记录 CEX 深度、池滑点、网络费、估值或库存原因。

**验收：** 报告固定规模基线和新方案在相同配对样本上的候选数、报价延迟、净利差异和 RPC 成本；没有数据优势就保留固定规模。

### P1：建立一个真实的质量入口与故障回归

**借鉴点：** ArbBridge 的 `make check` 统一格式、静态检查、带 race 的单测及 integration-tag 编译；其回放、故障和恢复用例不依赖人工记忆。

**当前基础：** 当前已有 registry、adapter、pool-state、prepare、收益和页面相关测试，但 `package.json` 只提供 `typecheck`/`build`，没有仓库级 test 命令。

**最小落地：** 添加不访问网络的 `npm test`，执行现有 `*.test.ts` 与 `*.check.ts`；再为 P0 intent/recovery 和决策复算各加入最小 fixture。外部 RPC/真实私钥测试继续显式分离，不能让默认质量门依赖它们。

**验收：** 干净环境一次命令能运行类型检查与离线回归；失败输出能定位到测试文件；CI/本地不读取 `.env` 中的真实凭据。

### P2：按事实做周期级对账，再评估账本和多进程

**借鉴点：** ArbBridge 的库存预留、三方对账和 PnL 归因能区分预期、成交、链上实际和账面结果。

**当前项目应采用的最小版本：** 一个交易周期终态时，写入并比较 DEX 实际 token 变化/交易费、OKX 实际成交量/均价/手续费、钱包与交易所余额前后差异；不一致即进入已有的人工处理路径。成交后字段在实际费用未完整读取前继续称为“估算”，不称“已实现 PnL”。

**不现在做：** 复式账本、自动再平衡、Redis 任务队列、独立 cron 服务。这些只有在出现多实例、持续库存迁移或会计合规需求时才值得引入。

## 明确不应照搬的部分

1. **不拆成 ArbBridge 的多个进程。** 当前单进程已经有观察器、Dashboard、健康和受控执行；在没有水平扩展与权限隔离需求时，服务拆分只会增加故障面。
2. **不为“未来可能多实例”预先加入 Redis。** 现有数据库命名锁满足单实例执行。只有部署两个以上执行副本或需要跨进程急停时，再引入带 TTL/续租/失锁降级的分布式锁。
3. **不复制其资产/证券专属风险。** 公司行为日历、发行方限额和可充提网络可达图应按本项目的链上资产和 OKX 事实重设，不能原样搬运。
4. **不复制单次 DEX 报价的曲线近似。** 当前 CLMM/Whirlpool/DLMM 必须以该规模的实际 Exact-In 为准。
5. **不降低既有交易报文校验。** 本项目对 Solana 路由、指令、simulation token delta 和费用的验证，以及池身份/Token-2022 限制，应当保留在任何新抽象之外。
6. **不把本地敏感文件当作模板。** ArbBridge 根目录可见 `.pem` 与 `keystore` 类文件名；本扫描没有读取其内容，也不据此断言是否泄露，但本项目应继续只以 `.env.example`/`config.example.yaml` 作为样例，真实配置保持忽略且不写进报告、fixture 或日志。

## 推荐实施顺序与决策门

| 阶段 | 只在此前条件满足时开始 | 交付物 | 不通过时的处理 |
| --- | --- | --- | --- |
| 0. 保持观察 | 当前默认状态 | 报价币估值与同一 scan 可比性证据 | 保持 `NOT_EXECUTABLE`，不打开候选交易。 |
| 1. 可复算 | 收益输入完整 | 双快照记录、离线回放 fixture、统一测试入口 | 继续只做观察，修复缺失输入。 |
| 2. 可恢复 | 有明确执行路线和预置库存 | intent、启动恢复、故障矩阵、周期事实对账 | 自动执行保持 disarm。 |
| 3. 可控执行 | 2 通过且运营者可处置异常 | 持久化急停、preflight 报告、报警/仪表盘 | 只允许受限 dry-run/canary，不允许常态自动交易。 |
| 4. 规模优化 | 有足够成对且可复算的历史样本 | 多规模报价/选择对照报告 | 若收益或 RPC 成本无优势，维持固定规模。 |

## 证据位置

### 当前项目

- 启动、健康、池状态持久化与优雅停机：`src/main.ts`。
- Direct Pool 扫描、估值门槛、候选与观察记录：`src/direct-pool/collector.ts`、`src/direct-pool/storage.ts`。
- 交易周期、锁、重报价、链上确认与人工对账暂停：`src/trading/executor.ts`、`src/trading/page.ts`、`src/trading/prepare.ts`。
- 收益核算和估值状态：`src/market/profit-calculation.ts`、`src/market/valuation.ts`。
- 当前测试/脚本边界：`package.json`、`src/**/*.test.ts`、`src/valuation.check.ts`。

### ArbBridge

- 分层、启动顺序、readyz 语义和扩展边界：`docs/03-architecture.md`。
- 行情录制/回放：`internal/marketdata/recorder.go`、`replay.go` 及 `test/replay/`。
- 执行 intent、幂等、恢复和失败状态机：`internal/exec/journal.go`、`idem.go`、`recovery.go`、`machine.go`。
- 风险、锁、急停、签名策略和指标：`internal/risk/`、`internal/platform/lock/`、`killswitch/`、`signer/`、`metrics/`。
- 部署前检查、监控和质量门：`tools/preflight/`、`deploy/trader/check-monitoring.sh`、`Makefile`。

## 本次扫描限制

这是源代码与配置样例的静态调研，不是生产审计。没有运行 ArbBridge 或当前项目的测试，未验证两个系统的数据库迁移可应用性、实际 RPC 延迟、报价误差、成交概率、运行告警或真实利润。任何开启交易的决定仍须以当前项目实际配置、受控 dry-run/canary 与人工风控审批为准。
