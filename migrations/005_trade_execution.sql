CREATE TABLE IF NOT EXISTS trade_cycle (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  inst_id VARCHAR(64) NOT NULL,
  chain_index VARCHAR(16) NOT NULL,
  direction VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  client_order_id VARCHAR(32) NULL,
  chain_tx_hash VARCHAR(128) NULL,
  dex_from_amount DECIMAL(40,18) NULL,
  dex_to_amount DECIMAL(40,18) NULL,
  cex_requested_size DECIMAL(30,10) NULL,
  cex_filled_size DECIMAL(30,10) NULL,
  cex_average_price DECIMAL(30,12) NULL,
  expected_net_profit_usdt DECIMAL(30,12) NULL,
  post_fill_net_profit_estimate_usdt DECIMAL(30,12) NULL,
  reason VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX ix_trade_cycle_status (status, created_at),
  INDEX ix_trade_cycle_route (inst_id, chain_index, created_at),
  UNIQUE KEY uq_trade_cycle_cl_ord_id (client_order_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trade_cycle_tx (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  trade_cycle_id BIGINT UNSIGNED NOT NULL,
  chain_index VARCHAR(16) NOT NULL,
  purpose VARCHAR(24) NOT NULL,
  tx_hash VARCHAR(128) NOT NULL,
  status VARCHAR(24) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_trade_cycle_tx_hash (tx_hash),
  INDEX ix_trade_cycle_tx_cycle (trade_cycle_id, created_at),
  CONSTRAINT fk_trade_cycle_tx_cycle FOREIGN KEY (trade_cycle_id) REFERENCES trade_cycle(id)
) ENGINE=InnoDB;
