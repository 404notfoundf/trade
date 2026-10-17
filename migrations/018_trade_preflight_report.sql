CREATE TABLE IF NOT EXISTS trade_preflight_report (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  schema_version SMALLINT UNSIGNED NOT NULL,
  config_version CHAR(64) NOT NULL,
  trigger_source VARCHAR(24) NOT NULL,
  overall_status VARCHAR(16) NOT NULL,
  report_json JSON NOT NULL,
  checked_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX ix_trade_preflight_checked (checked_at, id)
) ENGINE=InnoDB;
