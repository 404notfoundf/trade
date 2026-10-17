ALTER TABLE direct_pool_quote
  ADD INDEX ix_direct_quote_quoted_at (quoted_at);

ALTER TABLE opportunity
  ADD INDEX ix_opportunity_active (ended_at, legacy_sample, observed_at);
