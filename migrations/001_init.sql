CREATE TABLE IF NOT EXISTS health_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dependency VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL,
  message VARCHAR(500) NULL,
  observed_at DATETIME(3) NOT NULL,
  INDEX ix_health_observed (observed_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS asset_config_snapshot (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  inst_id VARCHAR(64) NOT NULL,
  chain_index VARCHAR(16) NOT NULL,
  token_address VARCHAR(64) NOT NULL,
  multiplier DECIMAL(30,18) NOT NULL,
  multiplier_raw JSON NOT NULL,
  observed_at DATETIME(3) NOT NULL,
  INDEX ix_asset_snapshot (inst_id, observed_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS quote_observation (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  inst_id VARCHAR(64) NOT NULL,
  direction VARCHAR(32) NOT NULL,
  size_usdt DECIMAL(30,10) NOT NULL,
  shares DECIMAL(30,10) NULL,
  token_amount DECIMAL(40,18) NULL,
  cex_vwap DECIMAL(30,12) NULL,
  cex_fee_rate DECIMAL(20,12) NULL,
  dex_usdt_amount DECIMAL(30,12) NULL,
  cex_fee_usdt DECIMAL(30,12) NULL,
  gas_usdt DECIMAL(30,12) NULL,
  gas_native_raw VARCHAR(100) NULL,
  gas_source VARCHAR(40) NULL,
  net_profit_usdt DECIMAL(30,12) NULL,
  roi DECIMAL(20,12) NULL,
  multiplier DECIMAL(30,18) NULL,
  multiplier_raw JSON NULL,
  cex_ts DATETIME(3) NULL,
  dex_ts DATETIME(3) NOT NULL,
  observed_at DATETIME(3) NOT NULL,
  is_stale BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(32) NOT NULL,
  price_impact_percent DECIMAL(20,10) NULL,
  from_token_unit_price_usd DECIMAL(30,12) NULL,
  to_token_unit_price_usd DECIMAL(30,12) NULL,
  paid_value_usd DECIMAL(30,12) NULL,
  received_value_usd DECIMAL(30,12) NULL,
  raw_response JSON NULL,
  INDEX ix_quote_observed (observed_at),
  INDEX ix_quote_bucket (observed_at, direction, size_usdt)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS opportunity (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  quote_observation_id BIGINT UNSIGNED NOT NULL,
  observed_at DATETIME(3) NOT NULL,
  direction VARCHAR(32) NOT NULL,
  size_usdt DECIMAL(30,10) NOT NULL,
  net_profit_usdt DECIMAL(30,12) NOT NULL,
  roi DECIMAL(20,12) NULL,
  INDEX ix_opportunity_observed (observed_at),
  INDEX ix_opportunity_stats (observed_at, direction, size_usdt),
  CONSTRAINT fk_opportunity_quote FOREIGN KEY (quote_observation_id) REFERENCES quote_observation(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS risk_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  inst_id VARCHAR(64) NOT NULL,
  size_usdt DECIMAL(30,10) NOT NULL,
  decision ENUM('BLOCK','WARN') NOT NULL DEFAULT 'BLOCK',
  reason_code VARCHAR(48) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  cex_ts DATETIME(3) NULL,
  quote_response JSON NULL,
  observed_at DATETIME(3) NOT NULL,
  INDEX ix_risk_event_observed (observed_at),
  INDEX ix_risk_event_code (reason_code, observed_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS report (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  period_type ENUM('hourly','daily') NOT NULL,
  period_start DATETIME NOT NULL,
  direction VARCHAR(32) NOT NULL,
  size_usdt DECIMAL(30,10) NOT NULL,
  opportunity_count INT UNSIGNED NOT NULL,
  max_profit DECIMAL(30,12) NULL,
  median_profit DECIMAL(30,12) NULL,
  p95_profit DECIMAL(30,12) NULL,
  average_profit DECIMAL(30,12) NULL,
  collected BOOLEAN NOT NULL,
  longest_positive_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  generated_at DATETIME NOT NULL,
  UNIQUE KEY uq_report (period_type, period_start, direction, size_usdt)
) ENGINE=InnoDB;
