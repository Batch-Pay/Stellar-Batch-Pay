# Batch Worker Webhook Delivery

## Overview

The background batch worker (`lib/stellar/batch-worker.ts`) reliably emits webhook events for all batch outcomes: `batch.completed` on success and `batch.failed` on failure.

## Event Lifecycle

### Success Path

When all operations in a batch succeed, the worker:

1. Updates the job status to `completed` in the job store.
2. Triggers a `batch.completed` webhook to all registered subscribers via `triggerWebhooksWithRetry`.

### Failure Path

When any operation fails or a top-level worker error occurs, the worker:

1. Updates the job status to `failed` and records the error in the job store.
2. Triggers a `batch.failed` webhook to all registered subscribers via `triggerWebhooksWithRetry`.

### Catch Block

The top-level `catch` block in `processJobInBackground` handles unrecoverable errors (e.g., invalid signing configuration, job store exceptions). It:

1. Logs the error with structured logging.
2. Marks the job as `failed`.
3. Fires the `batch.failed` webhook with the error details.

## Retry Semantics

`triggerWebhooksWithRetry` aborts each delivery attempt after 5 seconds, provides exponential backoff (500ms base), and retries on 5xx / network errors, including timeout failures, up to 4 additional attempts. It also logs every delivery attempt to the `webhook_deliveries` table for auditing.

## Webhook Payload Schema

All worker-emitted webhooks include:

```ts
{
  event: "batch.completed" | "batch.failed",
  payload: {
    jobId: string;
    network: "testnet" | "mainnet";
    batchId: string;
    summary: { successful: number; failed: number };
    error?: string; // included only on batch.failed
  },
  timestamp: string;
}
```

## Subscriber Guidance

Subscribers should treat `batch.failed` as a terminal state. The `summary.failed` and `payload.error` fields provide full context for reconciliation or alerting.

## Related

- #501 — catch block webhook delivery
- #513 — batch.completed on success path
- #338 — initial webhook implementation
