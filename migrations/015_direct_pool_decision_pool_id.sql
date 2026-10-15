ALTER TABLE direct_pool_decision
  ADD COLUMN pool_id VARCHAR(128) NULL AFTER chain_index,
  ADD INDEX ix_direct_decision_pool_window (created_at, pool_id, instrument_id, chain_index, direction);

UPDATE direct_pool_decision d
JOIN direct_pool_quote q ON q.id = d.selected_quote_id
SET d.pool_id = q.pool_id
WHERE d.pool_id IS NULL;
