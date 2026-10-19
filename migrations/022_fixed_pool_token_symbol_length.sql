ALTER TABLE dex_pool_state
  MODIFY COLUMN base_token_symbol VARCHAR(64) NOT NULL,
  MODIFY COLUMN quote_token_symbol VARCHAR(64) NOT NULL;
