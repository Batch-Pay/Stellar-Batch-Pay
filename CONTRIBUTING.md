# Contributing to Stellar BatchPay

This guide covers the local setup, architecture, testing workflow, and pull request expectations for `Stellar-Batch-Pay`.

## Prerequisites

- Node.js 22 or newer (see `engines.node` in `package.json`)
- npm 10 or newer (this repository's `packageManager` is npm)
- Rust toolchain with `wasm32-unknown-unknown`
- Soroban CLI

## Local Setup

1. Clone your fork and add the upstream remote if needed:

```bash
git clone https://github.com/<your-user>/Stellar-Batch-Pay.git
cd Stellar-Batch-Pay
git remote add upstream https://github.com/jahrulezfrancis/Stellar-Batch-Pay.git
```

2. Install JavaScript dependencies:

```bash
npm install
```

3. Install the Soroban target for contract builds:

```bash
rustup target add wasm32-unknown-unknown
```

4. Install Soroban CLI if it is not already available:

```bash
cargo install --locked soroban-cli
```

## Development Workflow

Run the web app locally:

```bash
npm run dev
```

The Next.js application will be available at `http://localhost:3000`.

## Project Architecture

The repository is organized into three main areas:

- `app/`: Next.js App Router pages and API routes
- `components/`: reusable client-side UI components
- `lib/stellar/`: parsing, validation, batching, and transaction-building logic
- `contracts/batch-vesting/`: Soroban smart contract for time-locked batch vesting
- `tests/`: Vitest unit tests for the JavaScript and TypeScript payment logic

### Key modules

- `lib/stellar/parser.ts`: converts JSON and CSV files into payment rows
- `lib/stellar/validator.ts`: validates Stellar addresses, assets, and batch settings
- `lib/stellar/batcher.ts`: groups valid payment instructions into transaction-safe batches
- `app/api/batch-build/route.ts`: builds unsigned batch transactions for wallet signing

## Testing

Run the main checks locally before opening a pull request:

```bash
npm test
npm run typecheck
```

Run Playwright end-to-end tests (installs Chromium browsers on first run):

```bash
npx playwright install chromium
npm run test:e2e
```

Run the production build:

```bash
npm run build
```

Run the Soroban contract tests from the `contracts/` workspace:

```bash
cargo test --manifest-path contracts/Cargo.toml
```

Build the Soroban contract artifacts:

```bash
cargo build --manifest-path contracts/Cargo.toml --target wasm32-unknown-unknown
```

Before opening a pull request, make sure the relevant local checks complete successfully.
The primary CI workflow now runs both Vitest and TypeScript typechecking, so `npm test` and `npm run typecheck` should both pass locally before you push.

Required GitHub status checks and the maintainer branch-protection checklist
are documented in [docs/ci-merge-gating.md](docs/ci-merge-gating.md).

## Pull Request Guidelines

- Create a focused branch from the latest `main`
- Keep each pull request scoped to a small set of related changes
- Add or update tests for behavior changes
- Update docs when the user-facing flow or developer workflow changes
- Include the linked issue numbers in the PR description
- Confirm the web app build and the relevant test suite pass locally before pushing

## Commit Guidelines

- Use clear commit messages describing the behavior change
- Avoid mixing refactors with unrelated fixes
- Do not force-push over someone else’s branch without coordination

## Security Audit Triage

A scheduled `.github/workflows/security-audit.yml` job runs `npm audit` and
`cargo audit` weekly on `main` and on every PR.

When an audit failure or security advisory lands:

1. Read the advisory linked in the job summary and confirm the affected
   package is actually reachable from runtime code (vs. a transitive dev-only
   dep). High/critical runtime advisories are blockers.
2. Bump the offending package or pin a patched version in `package.json` or
   `contracts/Cargo.toml`, then update the lockfile.
3. Run `npm install` then `npm test` and `npm run build` locally. For Cargo
   bumps, also run `cargo test --manifest-path contracts/Cargo.toml` to catch
   soroban-sdk breakage.
4. Review dependency bumps for `stellar`, `next`, `better-sqlite3`, and `react`
   individually before merging.
5. If the scheduled audit fails on `main`, the workflow opens an issue with
   the `security-audit` label. Triage using the steps above, then close the
   issue.

## Reporting Issues

When opening an issue or PR, include:

- expected behavior
- actual behavior
- reproduction steps
- logs, screenshots, or failing test output when available

## Toasts

To ensure a consistent user experience, we have standardized on Sonner for all toast notifications. Please use the wrapper provided in `lib/toast.ts` instead of importing `sonner` or `@/components/ui/use-toast` directly. An ESLint rule is in place to enforce this.
