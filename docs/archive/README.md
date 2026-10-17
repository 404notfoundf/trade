# 设计文档归档

这里保存已完成实现的设计与实施说明，用于追溯当时的约束、验收口径和决策背景；它们不应被当作当前待办或运行规范。

| 文档 | 状态 | 归档原因 |
| --- | --- | --- |
| `DIRECT_POOL_DASHBOARD_IMPLEMENTATION.md` | 已完成，2026-10-17 更新 | Direct Pool 收益看板三页拆分、连续窗口统计、窗口样本与全部窗口分页、`pool_id` 迁移和 Dashboard 路由已实现；保留观察与成交的口径边界。 |
| `DIRECT_POOL_ALL_POSITIVE_WINDOWS_DESIGN.md` | 已完成，2026-10-17 | Direct Pool 总览保留最近 20 个窗口，新增全部窗口分页页，并固定翻页时的时间边界；保留窗口和决策样本的观察口径。 |
| `ORCA_WHIRLPOOL_XSPCX_USDC_DESIGN.md` | 已完成，2026-10-16 | 固定 XSPCX/USDC Orca Whirlpool 的只读报价、Token-2022 审查、unsigned 模拟和 Dashboard 接入已实现；保留链上身份与验收约束供追溯。 |
| `OPPORTUNITY_CLUSTERING_DASHBOARD_DESIGN.md` | 已完成，2026-10-16 | 普通机会列表摘要、详情页 5 秒变化片段和观察估算边界已实现；保留聚合口径与执行隔离约束供追溯。 |
| `METEORA_DLMM_SPCX_USDC_DESIGN.md` | 实现与离线测试已完成，主网手工验收待完成，2026-10-16 | 固定 Meteora DLMM SPCXx/USDC observe-only 接入、Adapter 订阅、报价与模拟边界已实现；保留 Token-2022 白名单和手工验收口径供追溯。 |
