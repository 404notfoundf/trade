ALTER TABLE direct_pool_decision
  ADD COLUMN worst_case_net_profit_usdt DECIMAL(50,24) NULL AFTER net_profit_usdt,
  ADD COLUMN minimum_profit_status VARCHAR(24) NOT NULL DEFAULT 'NOT_APPLICABLE' AFTER worst_case_net_profit_usdt;
