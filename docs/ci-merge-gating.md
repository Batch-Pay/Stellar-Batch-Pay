# CI merge gating

This document lists the GitHub Actions checks that must pass before merging
to `main`, and the maintainer steps required to enforce them.

Branch protection cannot be enabled from a pull request. A repository admin
must apply the checklist below in the GitHub UI.

## Required status checks

These jobs run on every pull request targeting `main` and on every push to
`main`. Use the **exact** names below when configuring protection. If the
GitHub UI shows a workflow-prefixed variant (for example `CI / vitest`),
select that string from the Checks tab of a recent pull request instead of
guessing.

| Check name | Workflow | Job | What it proves |
| --- | --- | --- | --- |
| `vitest` | CI | `vitest` | Typecheck, lint, Vitest, env validation |
| `build` | CI | `build` | `next build` produces a production bundle |
| `e2e` | E2E (Playwright) | `e2e` | Playwright suite against a production server |
| `npm audit (high/critical)` | Security Audit | `npm-audit` | Runtime npm advisories at high/critical |
| `cargo audit (batch-vesting)` | Security Audit | `cargo-audit` | Contract crate advisories |

Workflow-prefixed names GitHub rulesets may display:

- `CI / vitest`
- `CI / build`
- `E2E (Playwright) / e2e`
- `Security Audit / npm audit (high/critical)`
- `Security Audit / cargo audit (batch-vesting)`

## Do not require these checks

Requiring a check that does not run on every pull request will block merges
forever on those PRs.

| Check | Why it must not be required on every PR |
| --- | --- |
| `batch-vesting` | Path-filtered to `contracts/**` and the contract workflow file |
| `keeper` | Schedule / `workflow_dispatch` only; never runs on pull requests |
| Vercel preview jobs | Third-party; not part of this repository's merge gate |

## Maintainer checklist

Complete this once on `Batch-Pay/Stellar-Batch-Pay` after the checks from a
pull request have appeared in the GitHub UI.

### Preferred: ruleset

1. Open **Settings → Rules → Rulesets**.
2. Create or edit a ruleset targeting the `main` branch.
3. Enable **Require a pull request before merging**.
4. Enable **Require status checks to pass**.
5. Add the five required check names from the table above (or the exact
   workflow-prefixed strings shown in the Checks tab).
6. Do not add `batch-vesting`, `keeper`, or Vercel preview jobs.
7. Save the ruleset.

### Classic branch protection

1. Open **Settings → Branches → Branch protection rules**.
2. Edit or create the rule for `main`.
3. Enable **Require a pull request before merging**.
4. Enable **Require status checks to pass before merging**.
5. Search for and select `vitest`, `build`, `e2e`,
   `npm audit (high/critical)`, and `cargo audit (batch-vesting)`.
6. Save the rule.

## Verify protection is on

Classic API (fails with "Branch not protected" until a classic rule exists):

```bash
gh api repos/Batch-Pay/Stellar-Batch-Pay/branches/main/protection
```

Rulesets:

```bash
gh api repos/Batch-Pay/Stellar-Batch-Pay/rulesets
```

## Playwright in CI

The e2e job installs browsers and runs tests with tools that exist after
`npm ci` (this repository's `packageManager` is npm):

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

Do not reintroduce `bunx` or `oven-sh/setup-bun` in `.github/workflows/e2e.yml`.
`tests/ci-workflows.test.ts` fails the Vitest job if those return.
