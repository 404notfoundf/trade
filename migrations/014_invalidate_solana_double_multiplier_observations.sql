UPDATE direct_pool_decision d
JOIN direct_pool_quote q ON q.id = d.selected_quote_id
SET d.valuation_status = 'INVALIDATED_MULTIPLIER',
    d.decision_status = 'BLOCKED',
    d.block_reason = 'INVALIDATED_SOLANA_DOUBLE_MULTIPLIER: historical observation applied the Token-2022 scaled UI multiplier and Backed multiplier twice'
WHERE q.pool_id = 'xnvda-solana-raydium-clmm'
  AND d.valuation_status = 'ASSUMED_1_TO_1';
