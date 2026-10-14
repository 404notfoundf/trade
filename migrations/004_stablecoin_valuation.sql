CREATE TABLE IF NOT EXISTS stablecoin_price_snapshot (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  chain_index VARCHAR(16) NOT NULL,
  token_address VARCHAR(128) NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  usd_price DECIMAL(30,12) NULL,
  source VARCHAR(32) NOT NULL,
  source_time DATETIME(3) NULL,
  fetched_at DATETIME(3) NOT NULL,
  status VARCHAR(24) NOT NULL,
  diagnostic VARCHAR(500) NULL,
  INDEX ix_stable_price_fetched (fetched_at),
  INDEX ix_stable_price_token (chain_index, token_address, fetched_at)
) ENGINE=InnoDB;

ALTER TABLE quote_observation
  ADD COLUMN native_quote_amount DECIMAL(30,12) NULL AFTER dex_usdt_amount,
  ADD COLUMN native_quote_symbol VARCHAR(16) NULL AFTER native_quote_amount,
  ADD COLUMN usdt_rate DECIMAL(30,12) NULL AFTER native_quote_symbol,
  ADD COLUMN conversion_cost_usdt DECIMAL(30,12) NULL AFTER usdt_rate,
  ADD COLUMN usdt_estimate DECIMAL(30,12) NULL AFTER conversion_cost_usdt,
  ADD COLUMN valuation_status VARCHAR(32) NOT NULL DEFAULT 'LEGACY_NOMINAL' AFTER usdt_estimate,
  ADD COLUMN price_source_time DATETIME(3) NULL AFTER valuation_status,
  ADD COLUMN quote_summary VARCHAR(500) NULL AFTER price_source_time;

ALTER TABLE report
  ADD COLUMN legacy_nominal TINYINT(1) NOT NULL DEFAULT 1 AFTER collected;
