ALTER TABLE quote_observation
  ADD COLUMN cex_received_at DATETIME(3) NULL AFTER cex_ts,
  ADD COLUMN dex_request_started_at DATETIME(3) NULL AFTER dex_ts,
  ADD COLUMN dex_queue_wait_ms DECIMAL(10,3) NULL AFTER dex_request_ms;
