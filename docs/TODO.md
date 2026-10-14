# 待办事项

## X Layer 授权方案评估

- [ ] 评估授权不足时由程序自动签名并广播 `approve` 交易。可选无限额度（少发授权交易，但获批 spender 的权限更大）或按需有限额度（权限较小，但可能频繁上链；为兼容部分代币，改额度时可能要先归零，[ERC-20 标准](https://eips.ethereum.org/EIPS/eip-20)也建议客户端考虑此做法）。实施前需限定代币和 OKX API 当前返回的 spender，并等待授权上链确认后重新报价再兑换。
- [ ] 核验 AAPLx、USDT0 是否支持 ERC-2612 `permit`，以及 OKX 聚合兑换是否能在兑换流程中使用该签名。若两端都支持，可免去单独广播授权交易；目前不能假设这些代币或聚合器已支持。[ERC-2612 规范](https://eips.ethereum.org/EIPS/eip-2612)
- [ ] 修正 `src/trading/prepare.ts` / `selectCall` 对授权 spender 的假设：使用 OKX `approve-transaction` 当前返回值，不要假设它等于兑换交易的 `tx.to`。

## 路线核验

- [ ] 启用 Solana 实盘路线前，核验当前 OKX 账户的 XAAPL 充值/提现路线及账户配置。

## 机会计算口径

- [ ] 为 Backed multiplier 响应建立可复核的官方契约或链上核验来源；在此之前继续将异常或无法验证的值作为停算条件。
