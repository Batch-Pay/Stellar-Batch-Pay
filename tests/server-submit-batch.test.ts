/**
 * Integration test for StellarService.submitBatch — verifies that both XLM
 * and issued assets (e.g. USDC) are correctly parsed and submitted (#319).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Account, Asset as StellarAsset, Keypair } from 'stellar-sdk';
import path from 'node:path';

process.env.JOB_STORE_PATH = path.join(process.cwd(), 'data', 'test-server-submit-batch.db');

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSubmitTransaction = vi.fn();
const mockLoadAccount = vi.fn();
const mockFetchBaseFee = vi.fn().mockResolvedValue(100);

vi.mock('stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('stellar-sdk')>();

  class MockTransactionBuilder {
    operations: unknown[] = [];

    constructor(_sourceAccount: unknown, _options: unknown) {}

    addMemo(_memo: unknown) {
      return this;
    }

    addOperation(operation: unknown) {
      this.operations.push(operation);
      return this;
    }

    setTimeout(_seconds: number) {
      return this;
    }

    build() {
      const envelope = {
        toXDR: () => 'mock-xdr',
      };
      return {
        operations: this.operations,
        sign: vi.fn(),
        hash: () => Buffer.from('mock-transaction-hash'),
        toEnvelope: () => envelope,
      };
    }
  }

  class MockServer {
    loadAccount = mockLoadAccount;
    submitTransaction = mockSubmitTransaction;
    fetchBaseFee = mockFetchBaseFee;
    feeStats = vi.fn().mockResolvedValue({
      fee_charged: { p90: '100' },
    });
  }

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: MockServer,
    },
    TransactionBuilder: MockTransactionBuilder,
    Operation: {
      ...actual.Operation,
      payment: (params: unknown) => params,
    },
    Memo: {
      ...actual.Memo,
      text: (value: string) => value,
      id: (value: string) => value,
    },
  };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SOURCE_KEYPAIR = Keypair.random();
const RECIPIENT_1 = Keypair.random().publicKey();
const RECIPIENT_2 = Keypair.random().publicKey();
const RECIPIENT_3 = Keypair.random().publicKey();
const USDC_ISSUER = Keypair.random().publicKey();

const payments = [
  { address: RECIPIENT_1, amount: '10.0000000', asset: 'XLM' },
  { address: RECIPIENT_2, amount: '20.0000000', asset: 'XLM' },
  { address: RECIPIENT_3, amount: '50.0000000', asset: `USDC:${USDC_ISSUER}` },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StellarService.submitBatch — asset parsing (#319)', () => {
  beforeEach(() => {
    mockLoadAccount.mockClear();
    mockSubmitTransaction.mockClear();
    mockFetchBaseFee.mockClear();
    mockLoadAccount.mockResolvedValue(new Account(SOURCE_KEYPAIR.publicKey(), '1'));

    mockSubmitTransaction.mockResolvedValue({ hash: 'mock-tx-hash-abc123' });
  });

  test('submits XLM and USDC payments without throwing', async () => {
    const { StellarService } = await import('../lib/stellar/server');

    const service = new StellarService({
      secretKey: SOURCE_KEYPAIR.secret(),
      network: 'testnet',
      maxOperationsPerTransaction: 100,
    });

    const result = await service.submitBatch(payments);

    expect(result.totalRecipients).toBe(3);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  test('builds correct Asset instances for XLM and USDC operations', async () => {
    const { StellarService } = await import('../lib/stellar/server');

    const service = new StellarService({
      secretKey: SOURCE_KEYPAIR.secret(),
      network: 'testnet',
      maxOperationsPerTransaction: 100,
    });

    await service.submitBatch(payments);

    const submittedTx = mockSubmitTransaction.mock.calls[0][0];
    const ops = submittedTx.operations;

    expect(ops).toHaveLength(3);

    // First two ops: XLM (native)
    expect(ops[0].asset.isNative()).toBe(true);
    expect(ops[1].asset.isNative()).toBe(true);

    // Third op: USDC issued asset
    expect(ops[2].asset.isNative()).toBe(false);
    expect(ops[2].asset.getCode()).toBe('USDC');
    expect(ops[2].asset.getIssuer()).toBe(USDC_ISSUER);
  });

  test('all results are successful', async () => {
    const { StellarService } = await import('../lib/stellar/server');

    const service = new StellarService({
      secretKey: SOURCE_KEYPAIR.secret(),
      network: 'testnet',
      maxOperationsPerTransaction: 100,
    });

    const result = await service.submitBatch(payments);

    expect(result.summary.successful).toBe(3);
    expect(result.summary.failed).toBe(0);
    for (const r of result.results) {
      expect(r.status).toBe('success');
      expect(r.transactionHash).toBe('mock-tx-hash-abc123');
    }
  });

  test('advances the source sequence between internal batches', async () => {
    const sourceAccount = new Account(SOURCE_KEYPAIR.publicKey(), '1');
    const incrementSpy = vi.spyOn(sourceAccount, 'incrementSequenceNumber');
    mockLoadAccount.mockResolvedValue(sourceAccount);
    mockSubmitTransaction.mockResolvedValue({ hash: 'batch-hash-1' });

    const { StellarService } = await import('../lib/stellar/server');

    const service = new StellarService({
      secretKey: SOURCE_KEYPAIR.secret(),
      network: 'testnet',
      maxOperationsPerTransaction: 2,
    });

    await service.submitBatch([
      { address: RECIPIENT_1, amount: '10.0000000', asset: 'XLM' },
      { address: RECIPIENT_2, amount: '20.0000000', asset: 'XLM' },
      { address: RECIPIENT_3, amount: '30.0000000', asset: 'XLM' },
    ]);

    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(incrementSpy).toHaveBeenCalledTimes(2);
  });
});

describe('StellarService.submitBatch — validation failures are not marked success (#389)', () => {
  beforeEach(() => {
    mockLoadAccount.mockClear();
    mockSubmitTransaction.mockClear();
    mockFetchBaseFee.mockClear();
    mockLoadAccount.mockResolvedValue(new Account(SOURCE_KEYPAIR.publicKey(), '1'));
    mockSubmitTransaction.mockResolvedValue({ hash: 'mock-tx-hash-389' });
  });

  test('an invalid row sharing a batch with a valid row stays failed after the tx lands', async () => {
    const { StellarService } = await import('../lib/stellar/server');

    const service = new StellarService({
      secretKey: SOURCE_KEYPAIR.secret(),
      network: 'testnet',
      maxOperationsPerTransaction: 100,
    });

    const result = await service.submitBatch([
      { address: RECIPIENT_1, amount: '10.0000000', asset: 'XLM' }, // valid
      { address: 'not-a-valid-stellar-address', amount: '5.0000000', asset: 'XLM' }, // invalid
    ]);

    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);

    // Only the valid payment should have been included in the envelope.
    const submittedTx = mockSubmitTransaction.mock.calls[0][0];
    expect(submittedTx.operations).toHaveLength(1);

    expect(result.summary.successful).toBe(1);
    expect(result.summary.failed).toBe(1);

    const valid = result.results.find((r) => r.recipient === RECIPIENT_1);
    const invalid = result.results.find(
      (r) => r.recipient === 'not-a-valid-stellar-address',
    );

    expect(valid?.status).toBe('success');
    expect(valid?.transactionHash).toBe('mock-tx-hash-389');

    // The row that never made it into the envelope must NOT be flipped to success.
    expect(invalid?.status).toBe('failed');
    expect(invalid?.transactionHash).toBeUndefined();
    expect(invalid?.error).toBeTruthy();
  });

  test('a batch where every row is invalid is never submitted', async () => {
    const { StellarService } = await import('../lib/stellar/server');

    const service = new StellarService({
      secretKey: SOURCE_KEYPAIR.secret(),
      network: 'testnet',
      maxOperationsPerTransaction: 100,
    });

    const result = await service.submitBatch([
      { address: 'bad-address-1', amount: '1.0000000', asset: 'XLM' },
      { address: 'bad-address-2', amount: '2.0000000', asset: 'XLM' },
    ]);

    expect(mockSubmitTransaction).not.toHaveBeenCalled();
    expect(result.summary.successful).toBe(0);
    expect(result.summary.failed).toBe(2);
    expect(result.results.every((r) => r.status === 'failed')).toBe(true);
  });
});

describe('StellarService.submitSingleBatch — no double-batching (#503)', () => {
  beforeEach(() => {
    mockLoadAccount.mockClear();
    mockSubmitTransaction.mockClear();
    mockFetchBaseFee.mockClear();
    mockLoadAccount.mockResolvedValue(new Account(SOURCE_KEYPAIR.publicKey(), '1'));
    mockSubmitTransaction.mockResolvedValue({ hash: 'single-batch-hash' });
  });

  function manyPayments(count: number) {
    return Array.from({ length: count }, () => ({
      address: Keypair.random().publicKey(),
      amount: '1.0000000',
      asset: 'XLM',
    }));
  }

  test('submits exactly ONE transaction even when given 101 payments', async () => {
    const { StellarService } = await import('../lib/stellar/server');

    const service = new StellarService({
      secretKey: SOURCE_KEYPAIR.secret(),
      network: 'testnet',
      maxOperationsPerTransaction: 100,
    });

    const result = await service.submitSingleBatch(manyPayments(101));

    // No internal re-batching: a single Horizon submission for the whole slice.
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
    expect(result.totalTransactions).toBe(1);
    expect(result.summary.successful).toBe(101);
    expect(mockSubmitTransaction.mock.calls[0][0].operations).toHaveLength(101);
  });

  test('worker flow: createBatches(101) + submitSingleBatch yields exactly 2 Horizon submissions', async () => {
    const { StellarService } = await import('../lib/stellar/server');
    const { createBatches } = await import('../lib/stellar/batcher');

    const service = new StellarService({
      secretKey: SOURCE_KEYPAIR.secret(),
      network: 'testnet',
      maxOperationsPerTransaction: 100,
    });

    const payments = manyPayments(101);
    const batches = await createBatches(payments, 100, { network: 'testnet' });
    expect(batches).toHaveLength(2);

    mockSubmitTransaction.mockClear();
    let txCount = 0;
    for (const batch of batches) {
      const res = await service.submitSingleBatch(batch.payments);
      txCount += res.totalTransactions;
    }

    // Horizon submission count matches the up-front batch count (#503).
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
    expect(txCount).toBe(2);
  });

  test('submitBatch (wrapper) still batches internally: 101 payments → 2 submissions', async () => {
    const { StellarService } = await import('../lib/stellar/server');

    const service = new StellarService({
      secretKey: SOURCE_KEYPAIR.secret(),
      network: 'testnet',
      maxOperationsPerTransaction: 100,
    });

    const result = await service.submitBatch(manyPayments(101));

    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
    expect(result.totalTransactions).toBe(2);
  });
});

describe('StellarService.submitBatch — tx_bad_seq retry with rebuild (#seq-retry)', () => {
  beforeEach(() => {
    mockLoadAccount.mockClear();
    mockSubmitTransaction.mockClear();
    mockFetchBaseFee.mockClear();
  });

  test('reloads account and retries current transaction after tx_bad_seq', async () => {
    const firstSourceAccount = new Account(SOURCE_KEYPAIR.publicKey(), '1');
    const refreshedSourceAccount = new Account(SOURCE_KEYPAIR.publicKey(), '2');

    mockLoadAccount
      .mockResolvedValueOnce(firstSourceAccount)
      .mockResolvedValueOnce(refreshedSourceAccount);

    const txBadSeqError = {
      response: {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_bad_seq',
            },
          },
        },
      },
      message: 'tx_bad_seq',
    };

    mockSubmitTransaction
      .mockRejectedValueOnce(txBadSeqError)
      .mockResolvedValueOnce({ hash: 'mock-tx-hash-retried' });

    const { StellarService } = await import('../lib/stellar/server');
    const service = new StellarService({
      secretKey: SOURCE_KEYPAIR.secret(),
      network: 'testnet',
      maxOperationsPerTransaction: 100,
    });

    const result = await service.submitBatch([
      { address: RECIPIENT_1, amount: '10.0000000', asset: 'XLM' },
      { address: RECIPIENT_2, amount: '20.0000000', asset: 'XLM' },
    ]);

    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    expect(result.summary.successful).toBe(2);
    expect(result.summary.failed).toBe(0);
    for (const row of result.results) {
      expect(row.status).toBe('success');
      expect(row.transactionHash).toBe('mock-tx-hash-retried');
    }
  });
});
