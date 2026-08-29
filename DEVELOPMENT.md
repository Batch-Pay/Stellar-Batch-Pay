# Development Guide

This guide explains the architecture, development practices, and how to extend the Stellar bulk payment system.

## Project Architecture

### Layered Design

The project follows a clean layered architecture with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────┐
│           UI Layer (Web & CLI)                          │
│  (pages, components, cli/index.ts)                      │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│        Application Layer (API Routes)                   │
│  (app/api/batch-submit/route.ts)                        │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│      Core Business Logic (lib/stellar/)                 │
│  - Types, Validation, Parsing, Batching, Services      │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│     External Services (Stellar SDK)                     │
│  (stellar-sdk)                                          │
└─────────────────────────────────────────────────────────┘
```

### Core Library Modules

**types.ts**
- Defines all TypeScript interfaces
- Single source of truth for data structures
- No dependencies, pure types

**validator.ts**
- Input validation logic
- Validates payments, configuration, and batches
- Clear error messages for debugging
- Used by both CLI and Web UI

**parser.ts**
- Parses JSON and CSV files
- Flexible input handling
- Validates structure and format

**batcher.ts**
- Splits payments into transaction batches
- Respects Stellar's 100-operation limit
- Utility functions for asset parsing and summaries

**stellar-service.ts**
- Main service for Stellar operations
- Handles transaction building, signing, and submission
- Manages sequence numbers and error handling
- Returns structured results

## Motion vocabulary

Dashboard and marketing UI share `MotionSafe` (`components/motion-safe.tsx`),
which disables Framer Motion when `prefers-reduced-motion` is set.

Presets live in `lib/motion-tokens.ts`:

| Preset | Use |
|--------|-----|
| `pageEnter` | Dashboard page shells (history, batch detail) |
| `stepEnter` | New-batch wizard steps |
| `fadeInUpMedium` | Metric cards and staggered grids |
| `motionCssDuration` | Tailwind `transition-all` durations aligned with tokens |

Prefer spreading a preset onto `MotionSafe` instead of ad hoc `animate-in`
utilities or raw `motion.div` on data-heavy routes. Utilitarian tables can
omit entrance animation entirely.

## Accessibility: bypass blocks

Use a "Skip to main content" link as the first focusable control in layouts
that introduce repeated navigation/UI chrome. The target landmark should be a
stable `<main id="main-content">` on the rendered page shell (for example,
dashboard and primary marketing/demo routes), so keyboard and assistive
technology users can bypass sidebars/headers quickly (WCAG 2.4.1).

## Key Design Decisions

### 1. No ORM or Additional Abstraction

The service directly uses `stellar-sdk` without intermediate layers. This keeps the code simple and maintainable.

### 2. Separation of Concerns

- **Input Parsing**: Handled separately from validation
- **Validation**: Independent of business logic
- **Batching**: Pure function with no side effects
- **Stellar Operations**: Isolated in StellarService

### 3. Structured Results

All operations return structured result objects rather than throwing exceptions. This allows:
- Partial success reporting (some payments succeed, others fail)
- Detailed error information per recipient
- Easy JSON serialization

### 4. Environment-Based Configuration

Secret keys come from environment variables, never from configuration files. This enforces security best practices.

## Adding New Features

### Adding a New Asset Type Handler

If you need special handling for a specific asset:

1. Update `parseAsset()` in `lib/stellar/utils.ts` — this is the **single shared parser** used by both `batcher.ts` and `server.ts`
2. Add validation in `validator.ts`
3. Update type definitions in `types.ts`
4. Add tests in `tests/`

> **Important — server-side signing:** `StellarService` in `server.ts` (used by `/api/batch-submit` with `STELLAR_SECRET_KEY`) builds payment operations by calling `parseAsset` from `lib/stellar/utils.ts`. This shared parser handles `"XLM"`, `"native"`, and `"CODE:ISSUER"` strings. Do **not** introduce a local `parseAsset` in `server.ts`; doing so will break issued-asset batches (USDC, etc.) on the server-submit path.

> **Local server-signing tests:** To test the `/api/batch-submit` or `/api/batch-retry` server-signing path locally, set `ALLOW_SERVER_SIGNING=true` alongside `STELLAR_SECRET_KEY`. Without this flag the routes return 403. The test suite (`tests/batch-submit.test.ts`) sets this flag automatically. See DEPLOYMENT.md for full security guidance before enabling in any deployed environment.

### Adding Rate Limiting

To add rate limiting per account:

1. Create `lib/stellar/rate-limiter.ts`
2. Track submission times per public key
3. Return error if limit exceeded
4. Update StellarService to use it

### Adding Database Support

For production deployments wanting to track batch history:

1. Create `lib/stellar/persistence.ts`
2. Use database adapter pattern
3. Store results before returning to user
4. Add endpoint to retrieve historical results

### Adding Multi-Signature Support

For advanced security:

1. Create `lib/stellar/multisig.ts`
2. Handle multiple signers
3. Update transaction signing in StellarService
4. Add configuration for signers

## Contract Development

### Prerequisites

To work on the Soroban smart contracts, you need:
1. **Rust & WASM**: [Install Rust](https://rustup.rs/) and add the WASM target:
   ```bash
   rustup target add wasm32-unknown-unknown
   ```
2. **Stellar CLI**: [Install the Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup#install-the-stellar-cli):
   ```bash
   cargo install --locked stellar-cli --features opt
   ```
3. **Docker**: Required for running a local Stellar node.

### Local Environment Setup

We use the [Stellar Quickstart](https://github.com/stellar/docker-stellar-quickstart) Docker image to run a local network with Soroban RPC enabled.

1. **Start the full stack** (Stellar node + Next.js app):
   ```bash
   docker compose up -d
   ```
   This starts both the Stellar quickstart node and the Next.js app:
   - Horizon on port `8000`
   - Soroban RPC on port `8001`
   - Next.js app on port `3000`

   To run only the Stellar node (e.g. during active development with `npm run dev`):
   ```bash
   docker compose up -d stellar
   ```

   The `stellar/quickstart` image is pinned to a specific release tag in
   `docker-compose.yml` rather than `latest`, so a fresh clone produces the
   same Horizon/Soroban RPC versions on every machine. Do not change the
   pin without following the upgrade procedure below.

### Updating the stellar/quickstart pin

The `image:` line in `docker-compose.yml` references a versioned
`stellar/quickstart` tag (e.g. `stellar/quickstart:23.0.6-2304`). Rotate
it deliberately — a wrong pin can break contract deploys and friendbot.

1. Pick a candidate tag from
   [Docker Hub](https://hub.docker.com/r/stellar/quickstart/tags). Prefer
   release-style tags (`<major>.<minor>.<patch>-<build>`) over rolling
   ones like `latest`, `testing`, or `future`.
2. (Optional, recommended) Resolve the tag to an immutable digest:
   ```bash
   docker pull stellar/quickstart:<tag>
   docker inspect --format='{{index .RepoDigests 0}}' stellar/quickstart:<tag>
   ```
   Use the resulting `stellar/quickstart@sha256:...` form in
   `docker-compose.yml` for full reproducibility.
3. Smoke-test the new image locally:
   ```bash
   docker compose down -v
   docker compose up -d
   ./scripts/deploy-contract.sh local alice
   cargo test --manifest-path contracts/Cargo.toml
   ```
4. Update any CI workflow that boots the quickstart image so it
   references the same pin.
5. Open a PR with the version bump and a one-line release note in the
   description (link to the upstream changelog).

2. **Configure Stellar CLI for Local**:
   ```bash
   stellar network add --rpc-url http://localhost:8001 --network-passphrase "Standalone Network ; February 2017" local
   ```

3. **Generate and Fund Test Keys**:
   Create a local identity for deployment and testing:
   ```bash
   stellar keys generate --network local alice
   ```
   Note: In standalone mode, the CLI will automatically try to fund the account via the local friendbot. If you need to fund it manually:
   ```bash
   curl "http://localhost:8000/friendbot?addr=$(stellar keys address alice)"
   ```

### Building and Testing Contracts

The contracts are located in the `contracts/` directory.

1. **Build the contract**:
   ```bash
   cd contracts/batch-vesting
   cargo build --target wasm32-unknown-unknown --release
   ```

2. **Run tests**:
   ```bash
   cargo test
   ```

### Deployment

#### Deploy to Local
Use the provided script to deploy to your local node:
```bash
./scripts/deploy-contract.sh local alice
```

#### Deploy to Testnet
1. **Configure Testnet**:
   ```bash
   stellar network add --rpc-url https://soroban-testnet.stellar.org:443 --network-passphrase "Test SDF Network ; September 2015" testnet
   ```
2. **Generate/Add Testnet Account**:
   ```bash
   stellar keys generate --network testnet deployer
   ```
3. **Deploy**:
   ```bash
   ./scripts/deploy-contract.sh testnet deployer
   ```

### Contract Architecture: Batch Vesting

The `batch-vesting` contract allows a sender to deposit tokens for multiple recipients with a shared unlock time.

- **Storage**: Uses `Persistent` storage for vesting records.
- **Limits**: Enforces `MAX_BATCH_SIZE = 100` to ensure transactions fit within ledger limits.
- **Security**: Only the recipient can claim their funds, and only after the `unlock_time`.

### Contract Upgrades

The contract uses Soroban's standard upgradeability pattern. Upgrades are gated by admin authorization and a configurable timelock to ensure security and transparency.

1. **Propose Upgrade**: The admin calls `propose_upgrade(new_wasm_hash)`. This records the hash and calculates an execution timestamp based on the current `upgrade_timelock` configuration.
2. **Wait**: The community/users have a window to review the new code before the timelock expires.
3. **Execute Upgrade**: After the timelock expires, the admin calls `execute_upgrade()`. This replaces the contract code with the new WASM while preserving all current storage.

**Events for Auditability**:
- `UpgradeProposed(new_wasm_hash, execute_at)`
- `UpgradeExecuted(new_wasm_hash)`

## React Query Provider

A single `QueryClientProvider` wraps the entire application tree in the root
`app/layout.tsx` via the `QueryProvider` component (`components/query-provider.tsx`).
No other layout or page component should nest a second `QueryClientProvider` or
create a separate `QueryClient` instance — nested providers create independent
caches, breaking `invalidateQueries` across the app and causing duplicate network
fetches for the same query key.

- Default `staleTime` is 30 000 ms, retry count is 1, and `refetchOnWindowFocus`
  is disabled (see `components/query-provider.tsx`).
- Dashboard routes (wrapped by `DashboardLayout` in `components/dashboard-layout.tsx`)
  rely on the root provider; do not reintroduce a second provider there.
- All `useQuery`, `useMutation`, and `invalidateQueries` calls share the same
  `QueryClient` instance and cache namespace.

### Query keys

Query keys come from the central factory in `lib/query-keys.ts` — do not write
raw string-literal keys in hooks or components. The hierarchy is parent → child:

- `batchHistoryKeys.all(publicKey)` → `["batch-history", publicKey]` (parent)
- `batchHistoryKeys.list(publicKey, …filters)` → `["batch-history", publicKey, …filters]` (children: pagination/filter/sort)
- `dashboardMetricsKeys.all(publicKey)` / `dashboardMetricsKeys.detail(publicKey, network, range)`

TanStack Query matches partially by default (`exact: false`), so **invalidate via
the `.all(publicKey)` parent** to refetch every paginated/filtered child list.
Batch history and dashboard metrics are separate namespaces: when a batch
completes, invalidate **both** parents (see `contexts/BatchFlowContext.tsx`) so the
recent table, the history page, and the metric cards all refresh.

## Testing Strategy

### Unit Tests

Test individual functions in isolation:

```typescript
// Test validator
validatePaymentInstruction(...)
validatePaymentInstructions(...)

// Test parser
parseJSON(...)
parseCSV(...)

// Test batcher
createBatches(...)
getBatchSummary(...)
```

### Integration Tests

Test the full flow with mock Stellar server:

```typescript
// Would require mocking stellar-sdk
const service = new StellarService(config);
const result = await service.submitBatch(payments);
// Assert result structure
```

### Manual Testing

1. **CLI Testing**:
   ```bash
    # The canonical CLI entry point is cli/index.ts (the package.json bin target).
    # Use `bun run cli` or the global `stellar-batch-pay` bin:
    STELLAR_SECRET_KEY="..." bun run cli submit \
      examples/payments.json \
      --network testnet

    # Alternatively invoke the bin directly with bun:
    STELLAR_SECRET_KEY="..." bun cli/index.ts submit \
      examples/payments.json \
      --network testnet
   ```

2. **Web UI Testing**:
   ```bash
   npm run dev
   # Open http://localhost:3000
   # Upload test file
   ```

3. **Testnet Validation**:
   - Create testnet account at friendbot.stellar.org
   - Fund it with test lumens
   - Run against testnet
   - Verify transactions on https://stellar.expert/explorer/testnet

## Real-time Batch Progress (SSE)

Batch progress is streamed over Server-Sent Events from:

```text
GET /api/batch-events/:jobId?publicKey=<stellar-public-key>
```

The `publicKey` query parameter is required and must be a valid Stellar public
key. It scopes the lookup to the submitting account so clients cannot subscribe
to unrelated batch jobs.

Each event is sent as a standard `data:` frame containing JSON shaped like:

```json
{
  "jobId": "job_123",
  "status": "processing",
  "totalBatches": 3,
  "completedBatches": 1,
  "totalPayments": 250,
  "network": "testnet",
  "createdAt": "2026-06-24T12:00:00.000Z",
  "updatedAt": "2026-06-24T12:00:03.000Z",
  "result": null,
  "error": null
}
```

The stream sends an immediate update, then refreshes every second until the job
reaches a terminal `completed` or `failed` state. The response uses
`text/event-stream`, `Cache-Control: no-cache, no-transform`, and
`X-Accel-Buffering: no` so reverse proxies do not buffer live progress frames.

Browser clients should prefer `EventSource`:

```typescript
const params = new URLSearchParams({ publicKey });
const events = new EventSource(`/api/batch-events/${jobId}?${params}`);

events.onmessage = (event) => {
  const job = JSON.parse(event.data);
  if (job.status === "completed" || job.status === "failed") {
    events.close();
  }
};
```

`hooks/use-batch-polling.ts` uses this SSE endpoint first. If `EventSource` is
unavailable or the initial connection fails, it falls back to polling:

```text
GET /api/batch-status/:jobId?publicKey=<stellar-public-key>
```

The polling fallback starts at 2 seconds and backs off up to 30 seconds between
attempts.

## Code Quality Guidelines

### Naming Conventions

- **Functions**: `camelCase`, verbs for actions (`validatePayment`, `createBatch`)
- **Variables**: `camelCase`, nouns for data
- **Types**: `PascalCase`
- **Constants**: `UPPER_SNAKE_CASE`

### Comments

Write comments for:
- Complex algorithms (e.g., sequence number management)
- Why, not what (code shows what it does)
- Edge cases and limitations
- Transaction building logic

### Error Handling

- Throw errors for programmer mistakes (invalid config)
- Return errors in results for user input issues
- Provide context in error messages
- Include what was expected and what was received

### Validation

- Validate at entry points (parseInput, API routes)
- Validate early, fail fast
- Provide specific error messages for each field
- Test validation with both valid and invalid inputs

## Performance Considerations

### Sequence Number Management

The current implementation increments sequence numbers in memory. For production:

```typescript
// Current approach (in-memory)
let sequenceNumber = BigInt(sourceAccount.sequenceNumber);

// Production approach
// - Use database to track sequence numbers
// - Or implement read-modify-write with retry logic
```

### Batch Size Optimization

Current implementation uses hardcoded max of 100 operations. Consider:

```typescript
// Could be configurable based on fee market
const maxOps = network === 'testnet' ? 100 : 50;
```

### Error Retry Logic

Consider implementing retry for transient failures:

```typescript
async submitWithRetry(transaction, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await this.submitTransaction(transaction);
    } catch (error) {
      if (isTransientError(error) && i < maxRetries - 1) {
        await sleep(Math.pow(2, i) * 1000); // exponential backoff
      } else {
        throw;
      }
    }
  }
}
```

## Debugging

### Enable Debug Logging

Add to `stellar-service.ts`:

```typescript
private log(message: string, data?: any) {
  if (process.env.DEBUG) {
    console.error(`[StellarService] ${message}`, data);
  }
}
```

### Inspect Transactions

Before submitting:

```typescript
const transactionEnvelope = transaction.toXDR();
console.log('Transaction XDR:', transactionEnvelope);
```

### Monitor Stellar Network

- **Testnet Explorer**: https://stellar.expert/explorer/testnet
- **Mainnet Explorer**: https://stellar.expert/explorer/public
- **Horizon API**: https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structure

## Deployment Checklist

- [ ] All tests pass
- [ ] No console.log statements (use proper logging)
- [ ] Environment variables documented
- [ ] Rate limiting configured
- [ ] Error messages don't expose internal details
- [ ] Testnet validation completed
- [ ] Monitoring/alerting configured
- [ ] Backup and recovery plan in place
- [ ] Security review completed

## Security Best Practices

1. **Secret Key Management**
   - Never log secret keys
   - Always use environment variables
   - Consider using secret management service

2. **Input Validation**
   - Validate all external input
   - Check transaction limits
   - Verify addresses are valid Stellar keys

3. **Error Messages**
   - Don't reveal internal details
   - Don't expose secrets in errors
   - Log detailed info server-side only

4. **Transaction Safety**
   - Always use sequence numbers
   - Implement idempotency if needed
   - Consider transaction timeouts

5. **Network Security**
   - Use HTTPS for web UI
   - Validate Stellar server certificates
   - Use testnet for development

## Troubleshooting

### "Account does not exist" Error

The account hasn't been funded yet.
- Testnet: Use friendbot.stellar.org
- Mainnet: Fund with at least 1 XLM

### "tx_bad_seq" Error

Sequence number mismatch. Likely causes:
- Multiple submissions in parallel
- Account state changed between reads
- Need to implement sequence number tracking

### "op_no_destination" Error

Recipient address is invalid:
- Check Stellar address format
- Verify address exists and is funded

### Large Batch Timeouts

Batch is too large for single transaction:
- Reduce `maxOperationsPerTransaction`
- Split into multiple batches
- Consider network congestion

## Future Improvements

1. **Event Sourcing**: Store all actions for audit trail
2. **Realtime Transport Hardening**: Add deployment-specific checks for SSE proxy buffering and timeout behavior
3. **GraphQL API**: More flexible querying
4. **Multi-language SDKs**: Python, Go, Rust versions
5. **Scheduler**: Automated batch submissions at intervals
6. **Analytics Dashboard**: Track batch history and metrics

## Migration Notes

### Legacy Idempotency Helpers Removed

The legacy idempotency helpers `getJobIdByIdempotencyKey` and `storeIdempotencyKey` have been removed from `lib/job-store.ts` as they queried the outdated SQLite column `key` instead of the modern schema layout which supports request hashing and expiration. All new paths use `createIdempotentJob`.
