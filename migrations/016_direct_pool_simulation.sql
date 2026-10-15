ALTER TABLE direct_pool_decision
  ADD COLUMN simulation_status VARCHAR(24) NOT NULL DEFAULT 'NOT_REQUESTED' AFTER execution_status,
  ADD COLUMN simulation_reason VARCHAR(500) NULL AFTER simulation_status,
  ADD COLUMN simulation_at DATETIME(3) NULL AFTER simulation_reason,
  ADD COLUMN simulation_input_debited_raw VARCHAR(100) NULL AFTER simulation_at,
  ADD COLUMN simulation_output_credited_raw VARCHAR(100) NULL AFTER simulation_input_debited_raw,
  ADD COLUMN simulation_network_fee_native_raw VARCHAR(100) NULL AFTER simulation_output_credited_raw,
  ADD COLUMN simulation_compute_units INT UNSIGNED NULL AFTER simulation_network_fee_native_raw;
