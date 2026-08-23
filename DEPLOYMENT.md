# Deployment Guide

Instructions for deploying the Stellar bulk payment system to production.

## Pre-Deployment Checklist

- [ ] All tests pass: `npm test`
- [ ] Code linted: `npm run lint`
- [ ] Build succeeds: `npm run build`
- [ ] Testnet validation completed
- [ ] Security review passed
- [ ] Environment variables configured
- [ ] Monitoring and logging setup
- [ ] Backup and disaster recovery plan in place

## Environment Setup

A complete list of supported variables with defaults and descriptions is
included in [`.env.example`](./.env.example). Copy it to `.env` and fill in
your values.

```bash
cp .env.example .env
```

### Required Environment Variables

```bash
# Production Stellar account
export STELLAR_SECRET_KEY="S..." # Never commit this!

# Optional: for enhanced security
export LOG_LEVEL="info"
export NODE_ENV="production"
```

### `ALLOW_SERVER_SIGNING` — Server-Side Transaction Signing (#596)

| Variable               | Default         | Purpose                                                                             |
| ---------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `ALLOW_SERVER_SIGNING` | `false` (unset) | Allow the server to sign and submit Stellar transactions using `STELLAR_SECRET_KEY` |

**Default behaviour (unset or `"false"`):** The API routes `/api/batch-submit` and `/api/batch-retry` reject server-signing requests with HTTP 403. Users must sign via a connected client wallet (Freighter). This is the safe default for public deployments.

**When `ALLOW_SERVER_SIGNING=true`:** The server signs transactions directly using `STELLAR_SECRET_KEY`. This is appropriate for:

- Internal/trusted deployments where the server is not publicly accessible
- Automated test pipelines (e.g. `tests/batch-submit.test.ts` sets this to `"true"`)
- Staging environments running automated batch jobs

### `SERVER_SIGNING_API_KEY` — Cryptographic Authorization (#696)

| Variable                  | Default         | Purpose                                                                                 |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------- |
| `SERVER_SIGNING_API_KEY`  | `""` (unset)    | Secret API key required in the `Authorization: Bearer` header for server-signing requests |

When `ALLOW_SERVER_SIGNING=true`, the server now enforces cryptographic authorization
on `/api/batch-submit` and `/api/batch-retry`. Callers must include the API key in the
`Authorization` header:

```
Authorization: Bearer <SERVER_SIGNING_API_KEY>
```

**Generate a secure key:**

```bash
openssl rand -hex 32
# Example output: a1b2c3d4e5f6...64-char-hex-string
```

**Backward-compatibility:** If `SERVER_SIGNING_API_KEY` is not set, the server
accepts server-signing requests without credential verification (the previous
behavior) but logs a deprecation warning on every request. Operators should
configure this variable in every deployment where server signing is enabled.

**Security warnings:**

- `ALLOW_SERVER_SIGNING=true` centralises key risk on the server. A compromised server can sign and submit arbitrary transactions.
- Always set `SERVER_SIGNING_API_KEY` when enabling server signing — it provides defense-in-depth beyond the network-layer controls.
- Never enable on public-facing production endpoints without additional access controls (VPN, IP allowlist, or mutual TLS).
- Requires `STELLAR_SECRET_KEY` to be set; the flag has no effect without it.
- Audit all access logs when this flag is active.

```bash
# Staging / internal use only
export ALLOW_SERVER_SIGNING=true
export STELLAR_SECRET_KEY="S..."
export SERVER_SIGNING_API_KEY="$(openssl rand -hex 32)"

# Production (public) — leave unset; users sign via Freighter wallet
# ALLOW_SERVER_SIGNING is intentionally absent
```

> **API error when disabled:** `POST /api/batch-submit` or `/api/batch-retry` without server signing enabled returns:
>
> ```json
> {
>   "error": "Server-side signing is disabled. Use client-side signing with a connected wallet, or enable ALLOW_SERVER_SIGNING=true in server configuration."
> }
> ```
>
> **API error for missing credential (401):**
>
> ```json
> {
>   "error": "Missing or malformed Authorization header. Server-signing requests require an 'Authorization: Bearer <SERVER_SIGNING_API_KEY>' header."
> }
> ```
>
> **API error for invalid credential (403):**
>
> ```json
> {
>   "error": "Invalid server-signing API key. The provided Authorization token does not match the configured SERVER_SIGNING_API_KEY."
> }
> ```
>
> See DEVELOPMENT.md for local test setup using this flag.

### `WALLET_AUTH_SECRET` — Wallet Session Authentication

Batch read/recover routes (`/api/batch-status`, `/api/batch-history`,
`/api/batch-recover`, `/api/batch-events`) require a short-lived wallet session
token issued after the connected wallet signs a SEP-10-style challenge. Knowing
a public G-address alone is no longer sufficient to read another user's payroll
data.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `WALLET_AUTH_SECRET` | dev fallback (non-production) | HMAC secret for session tokens |
| `WALLET_AUTH_SERVER_SECRET` | derived from secret | SEP-10 challenge server signing key |
| `WALLET_AUTH_HOME_DOMAIN` | hostname from `NEXT_PUBLIC_SITE_URL` | SEP-10 home domain |
| `WALLET_AUTH_WEB_AUTH_DOMAIN` | `stellar-batch-pay` | SEP-10 web auth domain |
| `WALLET_AUTH_SESSION_TTL_SEC` | `3600` | Session lifetime in seconds |

Generate a production secret:

```bash
openssl rand -hex 32
export WALLET_AUTH_SECRET="<output>"
```

See [docs/wallet-auth.md](./docs/wallet-auth.md) for the dashboard polling/SSE
flow and API usage.

### Environment Variable Management

**Do NOT commit `.env` files or secrets to version control.**

**Recommended approach:**

1. Use a secret management service (AWS Secrets Manager, HashiCorp Vault, etc.)
2. Set environment variables at deployment time
3. Use secure environment variable providers

**For Vercel deployment:**

```bash
vercel env add STELLAR_SECRET_KEY
```

## Keeper Bot Secret Management (#257)

The keeper bot (`scripts/keeper.ts`) reads `KEEPER_SECRET` from a pluggable
backend configured by `SECRET_BACKEND`.

### Backend: `env` (local development only)

```bash
export SECRET_BACKEND=env
export KEEPER_SECRET="S..."   # .env or shell — never commit
npx ts-node scripts/keeper.ts
```

A warning is printed at startup when using this backend in non-development
environments.

### Backend: `aws` (recommended for production)

1. Store the keeper secret in AWS Secrets Manager:
   ```bash
   aws secretsmanager create-secret \
     --name KEEPER_SECRET \
     --secret-string '{"KEEPER_SECRET":"S..."}'
   ```
2. Attach an IAM policy granting `secretsmanager:GetSecretValue` to the role
   running the keeper bot.
3. Set environment variables:
   ```bash
   export SECRET_BACKEND=aws
   export AWS_REGION=us-east-1
   # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or use instance/task role
   ```

### Backend: `github` (GitHub Actions CI/CD)

1. Add `KEEPER_SECRET` in your repository:
   **Settings → Secrets and variables → Actions → New repository secret**
2. Reference in your workflow:
   ```yaml
   jobs:
     keeper:
       steps:
         - name: Run keeper
           env:
             SECRET_BACKEND: github
             KEEPER_SECRET: ${{ secrets.KEEPER_SECRET }}
           run: npx ts-node scripts/keeper.ts
   ```

No secret is written to disk, logs, or intermediate environment files in the
`aws` or `github` backends.

### Keeper Bot Pagination Configuration (#586)

Recipients with more than `MAINTENANCE_LIMIT` vesting schedule entries require
multiple keeper runs to receive full TTL coverage. The bot persists a per-recipient
`nextMaintenanceIndex` cursor between runs so progress is never lost.

| Variable            | Default                    | Purpose                                                 |
| ------------------- | -------------------------- | ------------------------------------------------------- |
| `MAINTENANCE_LIMIT` | `10`                       | Number of schedule indices bumped per recipient per run |
| `KEEPER_STATE_PATH` | `./data/keeper-state.json` | JSON file storing per-recipient pagination cursors      |

**How many runs to achieve full coverage:**

If a recipient has `S` schedule entries and `MAINTENANCE_LIMIT=L`, full coverage
requires `ceil(S / L)` consecutive keeper runs. After the final window is processed
the cursor resets to 0 and the next run begins a fresh sweep.

```
Example: 50 schedule entries, MAINTENANCE_LIMIT=10 → 5 runs for full coverage.
```

**Tuning recommendations:**

- Increase `MAINTENANCE_LIMIT` to cover larger recipients in fewer runs. Keep it
  within Soroban transaction size limits (Stellar enforces a per-transaction instruction
  cap; values above 50 may require fee increases or encounter simulation errors).
- Set `KEEPER_STATE_PATH` to a persistent volume path in serverless/containerised
  deployments so the cursor survives cold starts.
- Keeper logs per-recipient progress: watch for `cursor reset to 0` lines to confirm
  a full sweep completed.

```bash
# Example: tune for recipients with up to 25 entries, 3 runs for full coverage
export MAINTENANCE_LIMIT=10
export KEEPER_STATE_PATH=/mnt/data/keeper-state.json
```

### Keeper Bot Exit Codes

The keeper script (`scripts/keeper.ts`) uses explicit exit codes so CI
workflows correctly report success or failure.

| Exit Code | Meaning |
| --------- | ------- |
| `0` | Keeper completed successfully — all recipients maintained, instance bumped, balance checked. |
| `1` | Keeper encountered a fatal error (missing config, RPC failure, transaction error, etc.). The alert webhook fires **before** the non-zero exit. |

**CI behaviour:**

- GitHub Actions treats exit code `0` as success (green checkmark) and any
  non-zero code as failure (red cross).
- The `Report failure` step in `.github/workflows/keeper.yml` runs on
  `if: failure()` and writes a job summary with the contract ID and run
  metadata, then creates or comments on a GitHub issue.

**Testing exit codes locally:**

```bash
# Success path (valid env)
npx ts-node scripts/keeper.ts; echo "exit: $?"

# Failure path (missing CONTRACT_ID)
CONTRACT_ID= npx ts-node scripts/keeper.ts; echo "exit: $?"
# → prints exit: 1
```

The `main` function is exported for programmatic testing via subprocess
spawn.

---

## Smart Contract Deployment

Follow these steps to deploy and initialize the Soroban smart contract.

### 1. Prerequisites

Ensure you have the following installed:

- [Rust](https://www.rust-lang.org/tools/install)
- [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup#install-the-stellar-cli)
- Wasm target: `rustup target add wasm32-unknown-unknown`

### 1a. Fee Asset Whitelist Configuration (#543)

The batch-vesting contract enforces a **single whitelisted fee asset** stored in the contract `Config`. This prevents admin key compromise from allowing arbitrary token fee collection that could drain depositors.

**Key points:**

- The fee asset is set **once** during contract initialization via `set_config()`
- `set_fee_config()` **no longer accepts** a `fee_asset` parameter — it only sets `fee_per_recipient` and `treasury`
- All deposit fees are automatically collected in the whitelisted asset
- Changing the fee asset requires a full `set_config()` call (admin-only)

**Recommended fee assets:**

- **Testnet/Mainnet**: Use native XLM (the network's Stellar Asset Contract address)
- **Private networks**: Use the native asset SAC address for that network

**Example initialization:**

```bash
# 1. Deploy contract
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/batch_vesting.wasm \
  --source deployer \
  --network testnet

# 2. Set admin
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- set_admin --admin <ADMIN_ADDRESS>

# 3. Initialize config with fee_asset (e.g., native XLM on testnet)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- set_config \
  --admin <ADMIN_ADDRESS> \
  --config '{
    "max_batch_size": 100,
    "max_schedules_per_recipient": 10,
    "upgrade_timelock": 604800,
    "fee_asset": "<XLM_SAC_ADDRESS>"
  }'

# 4. Set fee parameters (fee_asset NOT included — comes from config)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- set_fee_config \
  --admin <ADMIN_ADDRESS> \
  --fee_per_recipient 10000000 \
  --treasury <TREASURY_ADDRESS>
```

**Security notes:**

- Use a **Stellar multisig** (M-of-N threshold) for the admin account to prevent single-key compromise
- The `fee_asset` should be a **liquid, trusted token** (native XLM recommended)
- Never set `fee_asset` to a custom/illiquid token that depositors cannot easily obtain
- Document the chosen fee asset in your deployment runbook for transparency

### 2. Configure CLI Identity

Create an identity for deployment:

```bash
stellar keys generate --network testnet deployer
```

### 3. Build the Contract

Navigate to the contract directory and build the release Wasm:

```bash
cd contracts/batch-vesting
cargo build --target wasm32-unknown-unknown --release
```

The compiled contract will be available at:
`target/wasm32-unknown-unknown/release/batch_vesting.wasm`

### 4. Deploy to Testnet

Deploy the contract and capture the **Contract ID**:

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/batch_vesting.wasm \
  --source deployer \
  --network testnet
```

> [!NOTE]
> Save the returned `Contract ID` (starts with `C...`) as it is required for frontend integration.

### 5. Frontend Integration

Update your frontend `.env` file with the newly deployed Contract ID:

```bash
NEXT_PUBLIC_CONTRACT_ID="C..."
```

## Persistence and deployment modes

The API supports two deployment modes for batch job state, idempotency, and rate
limits. Set `DEPLOYMENT_MODE` to choose the right one.

### Single-node mode (default)

```bash
DEPLOYMENT_MODE=single-node  # or omit; this is the default
```

Jobs and rate limits are stored in local SQLite files. This is safe when exactly
one process accesses the store (e.g. `next start` behind a single-container
deploy, PM2 in cluster mode sharing the same filesystem, or Docker with a
mounted volume).

| Variable             | Default                | Purpose                   |
| -------------------- | ---------------------- | ------------------------- |
| `JOB_STORE_PATH`     | `./data/jobs.db`       | Durable batch job state   |
| `RATE_LIMIT_DB_PATH` | `./data/rate-limit.db` | Per-key API rate limiting |
| `WEBHOOK_ENCRYPTION_KEY` | unset*              | Stable key for encrypting webhook secrets |
| `WEBHOOK_ADMIN_API_KEY` | unset              | API key required for webhook management and delivery auditing |

Webhook registrations are stored in the same SQLite database as jobs and
delivery logs. The schema is created automatically by the `job-store`
initialization migration, so existing databases receive the `webhooks` table
on their next application start. Signing secrets are stored as a SHA-256 hash
and authenticated ciphertext; plaintext is returned only in the create
response and is never returned by the list endpoint.

`WEBHOOK_ENCRYPTION_KEY` must be set to the same long, random value in every
process sharing `JOB_STORE_PATH`. If it is omitted, the application uses the
configured auth secret when available, or a development fallback. Changing the
key makes existing webhook secrets undecryptable.

SQLite is configured with WAL mode, `busy_timeout = 5000ms`, and retry-with-jitter
to handle transient lock conflicts.

> **Warning:** Setting `JOB_STORE_PATH` or `RATE_LIMIT_DB_PATH` to `/tmp/*`
> makes them ephemeral. In-flight jobs and rate-limit state are lost on restart.
> The health endpoint flags this.

### HA mode (multi-instance)

```bash
DEPLOYMENT_MODE=ha
JOB_STORE_BACKEND=postgres   # default when ha
RATE_LIMIT_BACKEND=redis     # default when ha (also supports postgres)
DATABASE_URL=postgres://user:pass@host/dbname
REDIS_URL=redis://host:6379
```

Jobs and idempotency keys are stored in Postgres; rate limits use Redis (or
Postgres). All replicas share the same state, so:

- Idempotent submit is globally convergent (no duplicate payments).
- Rate limits apply fleet-wide.
- In-flight jobs survive cold starts and replica replacement.

| Variable              | Required when                       | Purpose                     |
| --------------------- | ----------------------------------- | --------------------------- |
| `DATABASE_URL`        | `JOB_STORE_BACKEND=postgres`        | Postgres connection string  |
| `REDIS_URL`           | `RATE_LIMIT_BACKEND=redis`          | Redis connection string     |
| `JOB_STORE_BACKEND`   | Optional; defaults to `postgres`    | `sqlite` or `postgres`      |
| `RATE_LIMIT_BACKEND`  | Optional; defaults to `redis`       | `sqlite`, `postgres`, `redis` |

The health endpoint (`GET /api/health`) reports `deploymentMode`, each backend's
connectivity status, and returns 503 when any store is unreachable or
misconfigured. Use it as a readiness probe.

### Which mode is safe?

| Topology                          | Mode          | Safe? |
| --------------------------------- | ------------- | ----- |
| Single container / single process | `single-node` | ✅     |
| Multiple replicas, shared volume  | `single-node` | ⚠️ Only with a single writer |
| Multiple replicas, no shared disk | `ha`          | ✅     |
| Serverless (ephemeral `/tmp`)     | `ha`          | ✅     |
| Serverless (ephemeral `/tmp`)     | `single-node` | ❌ Data lost on cold start    |

**Health check** — verify store connectivity before routing traffic:

```bash
curl -s http://localhost:3000/api/health
# Returns 200 with backend info, or 503 with config issues / connectivity errors
```

Set persistence variables in the same environment as your API routes (Vercel
project settings, Docker env, or systemd unit).

## Hosting Options

### Option 1: Vercel (Recommended for Next.js)

Vercel is optimized for Next.js applications:

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel

# Configure environment variables
vercel env add STELLAR_SECRET_KEY

# View deployment
vercel --prod
```

**Advantages:**

- Zero-config deployment
- Automatic scaling
- Global CDN
- Preview deployments
- Easy rollback

### Option 2: Docker Container

For flexibility and multi-platform deployment, use the committed
[`Dockerfile`](../Dockerfile) at the repo root. It is a multi-stage build
based on `node:22-alpine` that:

````dockerfile
FROM node:22-alpine

The accompanying `.dockerignore` keeps `node_modules`, `.next`,
`contracts/target`, `.env*`, and `data/` out of the build context.

**Build:**
```bash
docker build -t stellar-bulk-pay:latest .
````

**Run locally:**

```bash
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e STELLAR_SECRET_KEY="$STELLAR_SECRET_KEY" \
  -v "$(pwd)/data:/app/data" \
  stellar-bulk-pay:latest
```

**Push:**

```bash
docker tag stellar-bulk-pay:latest myregistry/stellar-bulk-pay:latest
docker push myregistry/stellar-bulk-pay:latest
```

**Deploy to container service:**

- AWS ECS — mount an EFS volume at `/app/data` if you need durable SQLite.
- Google Cloud Run — pair with a managed database, or accept that
  `data/` resets on each container instance.
- Azure Container Instances

### Option 3: Traditional VPS

For complete control:

```bash
# SSH to server
ssh user@server.com

# Clone repository
git clone https://github.com/your-org/stellar-bulk-pay.git
cd stellar-bulk-pay

# Install dependencies
npm ci --only=production

# Build
npm run build

# Set environment
export STELLAR_SECRET_KEY="S..."

# Start with process manager (PM2)
npm install -g pm2
pm2 start npm --name "stellar-bulk-pay" -- start
pm2 save
pm2 startup
```

## Security Considerations

### 1. Secret Management

**Never:**

- Commit `.env` files
- Pass secrets as command-line arguments
- Log secret keys
- Store in comments or documentation

**Always:**

- Use environment variables
- Rotate keys regularly
- Use secret management service
- Audit access logs

### 2. Network Security

```nginx
# HTTPS configuration
server {
    listen 443 ssl http2;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # Enforce HTTPS
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 3. Rate Limiting

Protect against abuse:

```typescript
// Example rate limiter middleware
import rateLimit from "express-rate-limit";

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
});

app.use("/api/", apiLimiter);
```

The app itself doesn't use the example above — it applies `applyRateLimit()` /
`setRateLimitHeaders()` per-route from `lib/api-rate-limit.ts`, with policies
keyed by endpoint and subscription tier (see `DEFAULT_LIMITS` in that file).
Every rate-limited response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
and `X-RateLimit-Reset` headers, plus `Retry-After` when blocked (HTTP 429).

Current per-endpoint policies (requests per rolling window, per tier):

| Endpoint              | Free | Pro | Enterprise | Window | Why                                                             |
| --------------------- | ---- | --- | ---------- | ------ | ---------------------------------------------------------------- |
| `batch-build`         | 8    | 20  | 60         | 60s    | Builds unsigned transactions                                     |
| `batch-submit`        | 5    | 15  | 45         | 60s    | Enqueues paid, server-signed work                                 |
| `batch-submit-signed` | 5    | 15  | 45         | 60s    | Enqueues paid, client-signed work                                 |
| `batch-retry`         | 5    | 15  | 45         | 60s    | Can re-enqueue paid, server-signed work (#743)                    |
| `batch-recover`       | 30   | 100 | 300        | 60s    | Enumerable per-job detail lookup (#743)                           |
| `batch-history`       | 20   | 60  | 180        | 60s    | Enumerable, supports search/aggregation across all jobs (#743)    |
| `batch-status`        | 60   | 200 | 600        | 60s    | Lightweight single-job polling                                    |
| `batch-events`        | 10   | 30  | 90         | 60s    | SSE stream open                                                   |
| `tx-status`           | 30   | 100 | 300        | 60s    | Single transaction status lookup                                  |
| `dashboard-metrics`   | 20   | 60  | 180        | 60s    | Aggregation across jobs                                           |
| `webhook-register`    | 3    | 10  | 30         | 60s    | Registers outbound webhook callbacks                              |
| `health`              | 30   | 100 | 300        | 60s    | Liveness/readiness checks                                         |

`RATE_LIMIT_BACKEND` (see above) determines where counters are stored —
SQLite for single-instance deployments, Redis or Postgres for HA. Limits can
be tuned via environment variables read by `tunedLimit()` in
`lib/api-rate-limit.ts` without redeploying code.

### 4. Input Validation

Always validate at the edge:

```typescript
// Validate batch size
if (payments.length > 10000) {
  return NextResponse.json(
    { error: "Batch size exceeds limit" },
    { status: 400 },
  );
}
```

### 5. Logging Security

**Safe to log:**

- Transaction hashes
- Public keys (anonymized)
- Error types (not messages)
- Timestamps

**Never log:**

- Secret keys
- Full request/response bodies
- User IP addresses (unless authorized)
- Sensitive amounts

```typescript
// Safe logging
console.log("[Payment] Transaction submitted:", {
  hash: txHash,
  recipientCount: payments.length,
  timestamp: new Date().toISOString(),
});

// Avoid
console.log("[Payment] Full config:", config); // Might contain secrets
```

## Monitoring and Observability

### Application Metrics

Track key metrics:

```typescript
// Example with StatsD
import StatsD from "node-dogstatsd";

const dogstatsd = new StatsD();

// Track batch submissions
dogstatsd.gauge("batches.size", payments.length);
dogstatsd.timing("batches.duration", duration);
dogstatsd.increment("batches.successful");
dogstatsd.increment("batches.failed");
```

### Error Tracking

Use a service like Sentry:

```typescript
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
});

// Errors are automatically captured
```

### Log Aggregation & Structured Request Logging

The application includes a structured JSON logger located at `lib/logger.ts` and Next.js middleware that assigns a unique correlation ID (`x-request-id`) to every incoming API request. The logger automatically anonymizes sensitive Stellar public keys (e.g., truncating them to `GB3...XYZ`) and outputs logs in JSON format:

```json
{
  "level": "info",
  "timestamp": "2026-05-31T20:00:00.000Z",
  "requestId": "a4f9c8f0-1e0f-4d77-9db6-9afcd21b8d05",
  "jobId": "5f8b3c20-3b02-4e63-bd4f-3f6291a13bfd",
  "publicKey": "GB3...XYZ",
  "network": "testnet",
  "msg": "Batch submit job queued and background worker triggered"
}
```

#### Datadog / CloudWatch Integration

1. **Datadog log ingestion**:
   - Ensure the Next.js runtime environment sends stdout/stderr logs directly.
   - In Datadog log configuration, enable the JSON parser so fields like `level`, `requestId`, and `jobId` are automatically parsed into searchable attributes.
   - Configure a mapping for standard attributes: map `level` to status, `timestamp` to date, and `msg` to message.

2. **AWS CloudWatch**:
   - Structured JSON logs are automatically parsed by CloudWatch logs.
   - Use CloudWatch Logs Insights to query and trace invocations across serverless instances using `requestId` or `jobId`:
     ```sql
     fields @timestamp, level, requestId, jobId, msg
     | filter requestId = "a4f9c8f0-1e0f-4d77-9db6-9afcd21b8d05"
     | sort @timestamp asc
     ```

## Database Setup (Optional)

For production batch tracking:

### PostgreSQL Setup

```sql
CREATE TABLE batches (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMP,
  network VARCHAR(20) NOT NULL,
  total_recipients INTEGER NOT NULL,
  total_amount DECIMAL(20, 7) NOT NULL,
  transaction_count INTEGER NOT NULL,
  successful_count INTEGER,
  failed_count INTEGER,
  status VARCHAR(20) NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  recipient VARCHAR(56) NOT NULL,
  amount DECIMAL(20, 7) NOT NULL,
  asset VARCHAR(255) NOT NULL,
  transaction_hash VARCHAR(64),
  status VARCHAR(20) NOT NULL,
  error_message TEXT
);

CREATE INDEX idx_batches_created_at ON batches(created_at);
CREATE INDEX idx_batches_network ON batches(network);
CREATE INDEX idx_payments_batch_id ON payments(batch_id);
```

## Performance Optimization

### Caching

Cache validator results:

```typescript
const validationCache = new Map<string, ValidationResult>();

function validateCached(payment: PaymentInstruction) {
  const key = JSON.stringify(payment);
  if (validationCache.has(key)) {
    return validationCache.get(key);
  }
  const result = validatePaymentInstruction(payment);
  validationCache.set(key, result);
  return result;
}
```

### Connection Pooling

For database connections:

```typescript
import { Pool } from "pg";

const pool = new Pool({
  max: 20,
  min: 4,
  idleTimeoutMillis: 30000,
});
```

### Batch Optimization

Tune batch size based on network conditions:

```typescript
// Adaptive batch sizing
const getBatchSize = (network: "testnet" | "mainnet") => {
  if (network === "testnet") return 100;
  // Mainnet might have higher fees, use smaller batches
  return 50;
};
```

## Rollback Plan

### Version Control

```bash
# Tag releases
git tag -a v1.0.0 -m "Production release"
git push origin v1.0.0

# Easy rollback if needed
git checkout v0.9.0
npm run build
npm start
```

### Blue-Green Deployment

Maintain two versions:

```bash
# Deploy new version to "green" environment
npm run deploy:green

# Test thoroughly
npm run test:e2e

# Switch traffic
npm run switch:traffic
```

## Testnet to Mainnet Migration

### 1. Validate on Testnet

```bash
# Test with testnet funds
STELLAR_SECRET_KEY="S..." npm run dev
# Submit test batches
# Verify transaction hashes on stellar.expert
```

### 2. Prepare Mainnet Account

```bash
# Create mainnet account
# Fund with adequate XLM
# Test basic operations

# Verify account
curl https://horizon.stellar.org/accounts/YOUR_PUBLIC_KEY
```

### 3. Gradual Migration

```bash
# Start with small batches
# Monitor for issues
# Gradually increase batch sizes
# Monitor transaction costs and success rates
```

### 4. Monitor Closely

```bash
# Check account balance
curl https://horizon.stellar.org/accounts/YOUR_PUBLIC_KEY/balances

# Review transaction history
curl "https://horizon.stellar.org/accounts/YOUR_PUBLIC_KEY/transactions"

# Monitor for errors
grep "ERROR" application.log
```

## Maintenance

### Regular Tasks

- **Daily**: Review error logs and transaction status
- **Weekly**: Monitor account balance and transaction costs
- **Monthly**: Review and archive logs, update dependencies
- **Quarterly**: Security audit, performance review

### Backup Strategy

```bash
# Backup application logs
tar -czf logs-backup-$(date +%Y%m%d).tar.gz /var/log/stellar-bulk-pay/

# Backup database
pg_dump stellar_bulk_pay > backup-$(date +%Y%m%d).sql

# Store offsite
aws s3 cp logs-backup-*.tar.gz s3://backups/
```

### Updates

```bash
# Check for updates
npm outdated

# Update dependencies
npm update

# Test thoroughly
npm test
npm run build

# Deploy updated version
git commit -am "Update dependencies"
git push origin main
```

## Disaster Recovery

### Account Recovery

If secret key is compromised:

1. Create new Stellar account
2. Transfer remaining funds
3. Update environment variables
4. Reissue all ongoing operations
5. Review transaction history

### Data Recovery

```bash
# Restore from backup
psql stellar_bulk_pay < backup-20240101.sql

# Verify integrity
SELECT COUNT(*) FROM batches;
```

### Incident Response

```bash
# 1. Identify issue
grep ERROR /var/log/stellar-bulk-pay/error.log

# 2. Stop processing
pm2 stop stellar-bulk-pay

# 3. Investigate
# Review logs, check Stellar network status

# 4. Fix and redeploy
git checkout main && npm run build && pm2 start stellar-bulk-pay

# 5. Verify
curl http://localhost:3000/api/health
```

## Support

For deployment issues:

- Check application logs
- Review Stellar network status
- Consult DEVELOPMENT.md for debugging
- Open GitHub issue with logs (no secrets)
