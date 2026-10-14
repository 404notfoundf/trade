ALTER TABLE quote_observation
  ADD COLUMN chain_index VARCHAR(16) NOT NULL DEFAULT '196' AFTER inst_id,
  ADD COLUMN route_status ENUM('ENABLED','MONITOR_ONLY','BLOCKED') NOT NULL DEFAULT 'MONITOR_ONLY' AFTER status,
  ADD INDEX ix_quote_route_bucket (chain_index, observed_at, direction, size_usdt);

ALTER TABLE opportunity
  ADD COLUMN chain_index VARCHAR(16) NOT NULL DEFAULT '196' AFTER quote_observation_id,
  ADD INDEX ix_opportunity_route_stats (chain_index, observed_at, direction, size_usdt);

ALTER TABLE risk_event
  ADD COLUMN chain_index VARCHAR(16) NOT NULL DEFAULT '196' AFTER inst_id,
  ADD COLUMN direction VARCHAR(32) NULL AFTER size_usdt,
  ADD INDEX ix_risk_route_observed (chain_index, observed_at);

ALTER TABLE report
  ADD COLUMN inst_id VARCHAR(64) NOT NULL DEFAULT 'XAAPL-USDT' AFTER period_start,
  ADD COLUMN chain_index VARCHAR(16) NOT NULL DEFAULT '196' AFTER inst_id,
  ADD COLUMN monitor_only_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER opportunity_count,
  DROP INDEX uq_report,
  ADD UNIQUE KEY uq_report (period_type, period_start, inst_id, chain_index, direction, size_usdt);

UPDATE report
SET monitor_only_count = opportunity_count,
    opportunity_count = 0,
    max_profit = NULL,
    median_profit = NULL,
    p95_profit = NULL,
    average_profit = NULL,
    longest_positive_seconds = 0;
