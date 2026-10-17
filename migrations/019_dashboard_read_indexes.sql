ALTER TABLE opportunity
  ADD INDEX ix_opportunity_dashboard (legacy_sample, observed_at, quote_observation_id);

ALTER TABLE quote_observation
  ADD INDEX ix_quote_opportunity_samples (inst_id, chain_index, direction, size_usdt, observed_at, status, valuation_status);

ALTER TABLE risk_event
  ADD INDEX ix_risk_event_decision_time (decision, observed_at);

ALTER TABLE report
  ADD INDEX ix_report_period_start (period_start);
