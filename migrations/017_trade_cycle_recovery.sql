ALTER TABLE trade_cycle
  ADD COLUMN execution_intent JSON NULL AFTER expected_net_profit_usdt,
  ADD COLUMN cex_order_intent JSON NULL AFTER execution_intent,
  ADD COLUMN cex_order_side VARCHAR(8) NULL AFTER cex_order_intent,
  ADD COLUMN cex_order_limit_price DECIMAL(30,12) NULL AFTER cex_order_side,
  ADD COLUMN cex_order_id VARCHAR(64) NULL AFTER cex_order_limit_price,
  ADD COLUMN cex_order_state VARCHAR(24) NULL AFTER cex_order_id,
  ADD COLUMN dex_actual_asset_delta_raw VARCHAR(80) NULL AFTER cex_order_state,
  ADD COLUMN dex_actual_quote_delta_raw VARCHAR(80) NULL AFTER dex_actual_asset_delta_raw,
  ADD COLUMN recovery_checked_at DATETIME(3) NULL AFTER dex_actual_quote_delta_raw;
