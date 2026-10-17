# Repository instructions

- This is the repository's Codex instruction file: keep global rules here and use the linked topic documents for detailed subsystem behavior.
- Reply in Chinese by default. Before changing code, inspect the relevant implementation and callers; prefer existing project patterns over new abstractions.
- Start with `git status --short` and inspect diffs for files you plan to touch. Preserve unrelated user changes; stage only files in the requested scope.
- Read [README.md](README.md), [docs/README.md](docs/README.md), and the relevant architecture or operation document before changing that area. For execution/recovery changes, read [docs/TRADING_EXECUTION.md](docs/TRADING_EXECUTION.md) and inspect `src/trading/`; for direct-pool changes, read [docs/DIRECT_POOL_ARCHITECTURE.md](docs/DIRECT_POOL_ARCHITECTURE.md).
- Do not treat a design or TODO document as proof that behavior is implemented. Verify the current code and migration state before describing behavior or changing it.

- Put design documents in `docs/` while the described work is active or pending implementation.
- Design documents that describe completed implementations must be moved to `docs/archive/`. Keep active architecture, operational, and future-phase design documents in `docs/`.
- When archiving a design document, update `docs/archive/README.md` with its filename, completion status, and a short reason for preservation.

## Change and verification workflow

- Keep changes within the user-requested scope. Do not enable live execution, change trade limits, add routes/pools, or alter deployment/runtime behavior as an incidental cleanup.
- For TypeScript changes, run `npm run typecheck` and `npm run build` when applicable. Tests use Node's built-in `node:test`; there is currently no `npm test` script. Run relevant tests explicitly, for example `node --import tsx --test src/profit-calculation.test.ts`.
- For a database schema change, add a new numbered SQL migration; never edit an already-applied migration. Update every query, store, report, and test that depends on the changed schema. Do not run `npm run db:migrate` against a configured database unless the user requested the database operation.
- Do not start the collector/dashboard, arm `/trade`, submit an exchange order, sign/broadcast a transaction, or call a live migration as a verification shortcut. Prefer unit tests and fakes; request explicit authorization before any external state-changing operation.
- Before handoff, run `git diff --check`, report the checks actually run, and state any important unverified behavior.

## Credentials and operational data

- Treat `.env`, `config.yaml`, logs, database dumps, wallet material, API responses, and recordings as sensitive. Do not print, copy into docs/tests, or commit their contents.
- Use `.env.example` and `config.example.yaml` as safe templates. Never commit real credentials, local runtime configuration, generated logs, or database exports.
- Preflight reports, execution records, and quote observations can contain operationally sensitive data. Persist only fields needed for audit/recovery and sanitize endpoint, credential, and raw-response data before logging or displaying it.
- Do not stage or commit unrelated files. When asked to commit, check the final staged diff and verify no local configuration or secret material is included.

## Trading and data invariants

- Financial decimal calculations use `decimal.js`; chain raw amounts use `bigint` or exact integer strings. Missing, stale, or unknown values are not zero and must not produce a comparable profit or a passing preflight.
- Keep `trading.enabled` default-off and preserve the separate `/trade` arm gate. Unknown or stale required preflight checks block arming; observation and simulation must never be represented as a real trade.
- Before an external side effect, persist its intent. On restart, query OKX/chain state; if the outcome remains unknown, keep execution disarmed and do not blindly resubmit an order or transaction. Never clear an unresolved cycle to make the service appear healthy.
- Direct-pool, Aggregator shadow, and simulation are separate paths. Do not silently fall back between quote providers; simulation must not broadcast.
- For execution/recovery details, follow [docs/TRADING_EXECUTION.md](docs/TRADING_EXECUTION.md); for direct-pool behavior, follow [docs/DIRECT_POOL_ARCHITECTURE.md](docs/DIRECT_POOL_ARCHITECTURE.md). Check current code where documentation and implementation may differ.
