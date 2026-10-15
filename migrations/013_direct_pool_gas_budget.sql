ALTER TABLE direct_pool_decision
  ADD COLUMN gas_budget_usdt DECIMAL(50,24) NULL AFTER dex_network_fee_usdt;
