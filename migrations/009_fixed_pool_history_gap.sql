CREATE TABLE IF NOT EXISTS dex_pool_history_gap (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  pool_id VARCHAR(128) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  recovered_at DATETIME(3) NOT NULL,
  reason VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_pool_history_gap_start (pool_id, started_at, reason),
  INDEX ix_pool_history_gap_retention (recovered_at)
) ENGINE=InnoDB;
