ALTER TABLE quote_observation
  ADD INDEX ix_quote_asset_chain_time (inst_id, chain_index, observed_at);

ALTER TABLE direct_pool_decision
  ADD INDEX ix_direct_decision_pool_time (pool_id, created_at);
