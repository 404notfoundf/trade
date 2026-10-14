SET @opportunity_windows_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema=DATABASE() AND table_name='quote_observation' AND column_name='dex_request_ms') = 0,
  'ALTER TABLE quote_observation ADD COLUMN dex_request_ms DECIMAL(10,3) NULL AFTER quote_summary',
  'SELECT 1'
);
PREPARE opportunity_windows_stmt FROM @opportunity_windows_ddl;
EXECUTE opportunity_windows_stmt;
DEALLOCATE PREPARE opportunity_windows_stmt;

ALTER TABLE opportunity
  ADD COLUMN inst_id VARCHAR(64) NULL AFTER quote_observation_id,
  ADD COLUMN ended_at DATETIME(3) NULL AFTER observed_at,
  ADD COLUMN close_reason VARCHAR(48) NULL AFTER ended_at,
  ADD COLUMN peak_profit_usdt DECIMAL(30,12) NULL AFTER net_profit_usdt,
  ADD COLUMN consecutive_misses TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER peak_profit_usdt,
  ADD COLUMN executable_status VARCHAR(24) NOT NULL DEFAULT 'NOT_EVALUATED' AFTER consecutive_misses,
  ADD COLUMN execution_buffer_usdt DECIMAL(30,12) NULL AFTER executable_status,
  ADD COLUMN executable_profit_usdt DECIMAL(30,12) NULL AFTER execution_buffer_usdt,
  ADD COLUMN execution_reason VARCHAR(500) NULL AFTER executable_profit_usdt,
  ADD COLUMN ever_executable BOOLEAN NOT NULL DEFAULT FALSE AFTER execution_reason,
  ADD COLUMN legacy_sample BOOLEAN NOT NULL DEFAULT FALSE AFTER ever_executable,
  ADD INDEX ix_opportunity_window (inst_id,chain_index,direction,size_usdt,ended_at);

UPDATE opportunity o
JOIN quote_observation q ON q.id=o.quote_observation_id
SET o.inst_id=q.inst_id,
    o.chain_index=q.chain_index,
    o.peak_profit_usdt=o.net_profit_usdt,
    o.ended_at=o.observed_at,
    o.close_reason='LEGACY_SAMPLE',
    o.legacy_sample=TRUE;

ALTER TABLE opportunity
  MODIFY COLUMN inst_id VARCHAR(64) NOT NULL,
  MODIFY COLUMN chain_index VARCHAR(16) NOT NULL;
