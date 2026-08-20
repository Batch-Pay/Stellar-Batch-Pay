# Wallet authentication for batch read APIs

Batch read and recover endpoints (`/api/batch-status`, `/api/batch-history`,
`/api/batch-recover`, `/api/batch-events`) contain sensitive payroll data.
Stellar G-addresses are public, so matching `publicKey` alone is not sufficient
authorization.

This document describes the SEP-10-style challenge flow used by the dashboard
for polling and SSE.

## Overview

1. The client requests a challenge for the connected wallet.
2. The wallet signs the challenge transaction (Freighter / Ledger / SEP-7).
3. The server verifies the signature and issues a short-lived session token.
4. Protected routes require the session token **and** matching `publicKey`.

`publicKey` remains a filter parameter, but only after cryptographic proof of
wallet ownership.

## Endpoints

### `POST /api/auth/challenge`

Request:

```json
{ "publicKey": "G..." }
```

Response:

```json
{
  "challengeXdr": "<base64 transaction envelope>",
  "expiresAt": "2026-08-20T00:05:00.000Z",
  "serverPublicKey": "G...",
  "networkPassphrase": "Test SDF Network ; September 2015"
}
```

Sign `challengeXdr` with the wallet that owns `publicKey`. The resulting signed
envelope is submitted to `/api/auth/verify`.

### `POST /api/auth/verify`

Request:

```json
{
  "publicKey": "G...",
  "signedChallengeXdr": "<base64 signed envelope>"
}
```

Response:

```json
{
  "sessionToken": "<bearer token>",
  "expiresAt": "2026-08-20T01:00:00.000Z",
  "publicKey": "G..."
}
```

The response also sets an HttpOnly cookie:

```
Set-Cookie: wallet_session=<token>; Path=/api; HttpOnly; SameSite=Lax
```

## Calling protected read routes

### Fetch / polling

Include the bearer token on each request:

```
Authorization: Bearer <sessionToken>
GET /api/batch-status/:jobId?publicKey=G...
```

The dashboard uses `authenticatedFetch()` from `lib/wallet-session-client.ts`,
which attaches the token from `sessionStorage` after `ensureWalletSession()`.

### Server-Sent Events (SSE)

`EventSource` cannot set custom headers. SSE requests rely on the HttpOnly
`wallet_session` cookie scoped to `/api`:

```
GET /api/batch-events/:jobId?publicKey=G...
Cookie: wallet_session=<token>
```

Same-origin dashboard requests send this cookie automatically once
`/api/auth/verify` has succeeded.

## Dashboard integration

- `WalletSessionProvider` (dashboard layout) calls `ensureWalletSession()` when
  the wallet connects.
- History tables, batch detail pages, and polling hooks wait for
  `sessionToken` before fetching.
- On wallet disconnect, the stored session is cleared.

## Environment variables

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `WALLET_AUTH_SECRET` | dev fallback | HMAC secret for session tokens |
| `WALLET_AUTH_SERVER_SECRET` | derived from secret | SEP-10 server signing key |
| `WALLET_AUTH_HOME_DOMAIN` | hostname from `NEXT_PUBLIC_SITE_URL` | SEP-10 home domain |
| `WALLET_AUTH_WEB_AUTH_DOMAIN` | `stellar-batch-pay` | SEP-10 web auth domain |
| `WALLET_AUTH_NETWORK_PASSPHRASE` | testnet in dev, mainnet in prod | Network for challenges |
| `WALLET_AUTH_CHALLENGE_TIMEOUT_SEC` | `300` | Challenge validity window |
| `WALLET_AUTH_SESSION_TTL_SEC` | `3600` | Session token lifetime |

Generate production secrets:

```bash
openssl rand -hex 32   # WALLET_AUTH_SECRET
# Optional dedicated SEP-10 server account:
# stellar keys generate -> WALLET_AUTH_SERVER_SECRET
```

## Security notes

- Challenges are single-use (replay rejected).
- Session tokens are bound to a specific `publicKey`.
- Wrong-wallet sessions receive HTTP 403 on publicKey mismatch.
- Unauthenticated reads receive HTTP 401 (no job payload leakage via auth bypass).

## Manual verification

```bash
# 1. Request challenge
curl -s -X POST http://localhost:3000/api/auth/challenge \
  -H 'Content-Type: application/json' \
  -d '{"publicKey":"G..."}'

# 2. Sign challengeXdr with Freighter or stellar-sdk, then verify
curl -s -X POST http://localhost:3000/api/auth/verify \
  -H 'Content-Type: application/json' \
  -d '{"publicKey":"G...","signedChallengeXdr":"..."}'

# 3. Read batch status with bearer token
curl -s "http://localhost:3000/api/batch-status/<jobId>?publicKey=G..." \
  -H "Authorization: Bearer <sessionToken>"
```

Without step 3's bearer token (or the `wallet_session` cookie), the read
routes return HTTP 401 even when `publicKey` is known.
