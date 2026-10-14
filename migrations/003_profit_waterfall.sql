ALTER TABLE quote_observation
  ADD COLUMN gross_profit_usdt DECIMAL(30,12) NULL AFTER net_profit_usdt,
  ADD COLUMN rebalance_cost_usdt DECIMAL(30,12) NULL AFTER gross_profit_usdt,
  ADD COLUMN net_profit_after_rebalance_usdt DECIMAL(30,12) NULL AFTER rebalance_cost_usdt;
