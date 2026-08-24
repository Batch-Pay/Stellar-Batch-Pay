# CI Next Build Pipeline

This document covers the implementation of the Next.js `build` job added to the pull request CI pipeline in `.github/workflows/ci.yml`, resolving issue #578.

## What Changed

A new `build` job was added to `.github/workflows/ci.yml`. It runs in parallel with the existing `vitest` job on every pull request targeting `main` and on every push to `main`. The job executes `next build` — the definitive check that all App Router pages, server components, API routes, and TypeScript types compile into a shippable production bundle.

Before this change, CI only ran the Vitest unit suite and a `tsc --noEmit` typecheck. Build-time errors such as incorrect dynamic imports, edge/Node.js runtime mismatches, and server components importing client-only modules could pass both checks and only surface as a failed deployment.

## Acceptance Criteria

### CI runs `next build` on pull requests targeting `main`

The workflow triggers on `pull_request: branches: [main]`. The `build` job calls `npm run build`, which maps to `next build` in `package.json`. Any build error causes the job to exit non-zero, failing the check.

### Build job uses frozen lockfile install consistent with the vitest job

Both jobs install dependencies with `npm ci`. This guarantees the exact same resolved dependency tree in both jobs and prevents silent lockfile drift during CI.

### Documented env stubs allow build without production secrets

The following variables are stubbed under the `Build Next.js application` step so that `next build` can complete without real credentials:

| Variable | Value | Why it is needed |
|---|---|---|
| `CI` | `true` | Tells Next.js to treat warnings as errors and suppress interactive prompts. |
| `NEXT_TELEMETRY_DISABLED` | `1` | Stops anonymous telemetry from being sent to Vercel during the build. This is the documented official opt-out. |
| `ALLOW_SERVER_SIGNING` | `false` | Disables the server-side Stellar signing path in `app/api/batch-submit/route.ts`. When set to anything other than `"true"`, the route returns early before it tries to read `STELLAR_SECRET_KEY`, so no real secret key is required. |
| `SECRET_BACKEND` | `env` | Selects the `EnvSecretsProvider` fallback in `lib/secrets/index.ts`. This prevents the secrets factory from attempting an AWS Secrets Manager or GitHub API call during the build. |

Network endpoint variables (`HORIZON_URL_TESTNET`, `SOROBAN_RPC_URL_TESTNET`, etc.) are intentionally not stubbed. `lib/stellar/network-config.ts` already falls back to hardcoded SDF public endpoints when these variables are absent, so no stub is required for a clean build.

### Failed builds block merge via required GitHub check

GitHub Actions does not enforce merge blocking automatically. A repository
admin must require status checks on `main`. `build` is one of those checks;
the full set (`vitest`, `build`, `e2e`, and the security-audit jobs) and the
maintainer UI checklist live in [docs/ci-merge-gating.md](docs/ci-merge-gating.md).

## Cache Strategy

The job caches `.next/cache` using `actions/cache@v4` with a key based on the hash of `package-lock.json`:

```
key: ${{ runner.os }}-nextjs-${{ hashFiles('**/package-lock.json') }}
restore-keys: |
  ${{ runner.os }}-nextjs-
```

A cache hit restores intermediate SWC and TypeScript compilation artefacts so subsequent builds only recompile modules that changed, reducing build time from a full O(M) compilation to an incremental O(ΔM) pass over changed modules.

## Files Changed

- `.github/workflows/ci.yml` — added the `build` job
