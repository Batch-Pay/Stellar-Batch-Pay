/**
 * Test suite for batching functions
 */

import { Keypair } from 'stellar-sdk';

import {
  createBatches,
  estimateBatchTransactionSize,
  getBatchSummary,
} from '../lib/stellar/batcher';
import { analyzeParsedPayments, parsePaymentFile } from '../lib/stellar/parser';
import { parseAsset } from '../lib/stellar/utils';

const firstAddress = Keypair.random().publicKey();
const secondAddress = Keypair.random().publicKey();
const thirdAddress = Keypair.random().publicKey();
const issuerAddress = Keypair.random().publicKey();

const samplePayments = [
  {
    address: firstAddress,
    amount: '100',
    asset: 'XLM',
  },
  {
    address: secondAddress,
    amount: '50',
    asset: 'XLM',
  },
  {
    address: thirdAddress,
    amount: '75',
    asset: 'XLM',
  },
];

describe('Batch Creation', () => {
  test('creates single batch when below max operations', async () => {
    const batches = await createBatches(samplePayments, 100);
    expect(batches).toHaveLength(1);
    expect(batches[0].payments).toHaveLength(3);
  });

  test('creates multiple batches when exceeding max operations', async () => {
    const batches = await createBatches(samplePayments, 2);
    expect(batches).toHaveLength(2);
    expect(batches[0].payments).toHaveLength(2);
    expect(batches[1].payments).toHaveLength(1);
  });

  test('assigns correct transaction indices', async () => {
    const batches = await createBatches(samplePayments, 1);
    expect(batches[0].transactionIndex).toBe(0);
    expect(batches[1].transactionIndex).toBe(1);
    expect(batches[2].transactionIndex).toBe(2);
  });

  test('preserves payment data in batches', async () => {
    const batches = await createBatches(samplePayments, 10);
    expect(batches[0].payments[0]).toEqual(samplePayments[0]);
  });

  test('handles single payment', async () => {
    const payments = [samplePayments[0]];
    const batches = await createBatches(payments, 1);
    expect(batches).toHaveLength(1);
    expect(batches[0].payments).toHaveLength(1);
  });

  test('handles large batch size', async () => {
    const batches = await createBatches(samplePayments, 1000);
    expect(batches).toHaveLength(1);
    expect(batches[0].payments).toHaveLength(3);
  });

  test('splits batches before exceeding transaction byte limit', async () => {
    const maxTransactionBytes =
      estimateBatchTransactionSize(samplePayments) - 1;

    const batches = await createBatches(samplePayments, 100, {
      maxTransactionBytes,
    });

    expect(batches).toHaveLength(2);
    expect(batches[0].payments).toHaveLength(2);
    expect(batches[1].payments).toHaveLength(1);
  });

  test('rejects a single payment that exceeds the size limit', async () => {
    const size = estimateBatchTransactionSize([samplePayments[0]]);

    await expect(
      createBatches([samplePayments[0]], 100, {
        maxTransactionBytes: size - 1,
      }),
    ).rejects.toThrow('exceeds the Stellar transaction size limit');
  });

  test('allows matching memos in the same transaction batch', async () => {
    const payments = [
      { ...samplePayments[0], memo: 'invoice-1', memoType: 'text' as const },
      { ...samplePayments[1], memo: 'invoice-1', memoType: 'text' as const },
    ];

    const batches = await createBatches(payments, 100);

    expect(batches).toHaveLength(1);
    expect(batches[0].payments).toHaveLength(2);
  });

  test('treats omitted memo type as a text memo for batch consistency', async () => {
    const payments = [
      { ...samplePayments[0], memo: 'invoice-1' },
      { ...samplePayments[1], memo: 'invoice-1', memoType: 'text' as const },
    ];

    const batches = await createBatches(payments, 100);

    expect(batches).toHaveLength(1);
    expect(batches[0].payments).toHaveLength(2);
  });

  test('allows a single memo in a transaction batch', async () => {
    const payments = [
      { ...samplePayments[0], memo: 'invoice-1', memoType: 'text' as const },
      samplePayments[1],
    ];

    const batches = await createBatches(payments, 100);

    expect(batches).toHaveLength(1);
    expect(batches[0].payments).toHaveLength(2);
  });

  test('rejects conflicting memo values in the same transaction batch', async () => {
    const payments = [
      { ...samplePayments[0], memo: 'invoice-1', memoType: 'text' as const },
      { ...samplePayments[1], memo: 'invoice-2', memoType: 'text' as const },
    ];

    await expect(createBatches(payments, 100)).rejects.toThrow(
      'Conflicting memos in transaction batch 1: Row 1 has text memo "invoice-1"; Row 2 has text memo "invoice-2"',
    );
  });

  test('rejects conflicting memo types in the same transaction batch', async () => {
    const payments = [
      { ...samplePayments[0], memo: '12345', memoType: 'id' as const },
      { ...samplePayments[1], memo: '12345', memoType: 'text' as const },
    ];

    await expect(createBatches(payments, 100)).rejects.toThrow(
      'Row 1 has id memo "12345"; Row 2 has text memo "12345"',
    );
  });

  test('allows distinct memos after operation-limit splitting', async () => {
    const payments = [
      { ...samplePayments[0], memo: 'invoice-1', memoType: 'text' as const },
      { ...samplePayments[1], memo: 'invoice-2', memoType: 'text' as const },
    ];

    const batches = await createBatches(payments, 1);

    expect(batches).toHaveLength(2);
  });

  test('reports preserved upload row numbers for conflicting memos', async () => {
    const payments = [
      {
        ...samplePayments[0],
        memo: 'invoice-1',
        memoType: 'text' as const,
        rowIndex: 4,
      },
      {
        ...samplePayments[1],
        memo: 'invoice-2',
        memoType: 'text' as const,
        rowIndex: 9,
      },
    ];

    await expect(createBatches(payments, 100)).rejects.toThrow(
      'Row 5 has text memo "invoice-1"; Row 10 has text memo "invoice-2"',
    );
  });
});

describe('Asset Parsing', () => {
  test('parses native XLM', () => {
    const asset = parseAsset('XLM');
    expect(asset.isNative()).toBe(true);
  });

  test('parses issued asset', () => {
    const asset = parseAsset(`USDC:${issuerAddress}`);
    expect(asset.getCode()).toBe('USDC');
    expect(asset.getIssuer()).toBe(issuerAddress);
  });

  test('parses asset with long code', () => {
    const asset = parseAsset(`LONGCODE123:${issuerAddress}`);
    expect(asset.getCode()).toBe('LONGCODE123');
    expect(asset.getIssuer()).toBe(issuerAddress);
  });
});

describe('Batch Summary', () => {
  test('calculates total amount', () => {
    const summary = getBatchSummary(samplePayments);
    expect(summary.totalAmount).toBe('225');
  });

  test('counts recipients', () => {
    const summary = getBatchSummary(samplePayments);
    expect(summary.recipientCount).toBe(3);
  });

  test('groups by asset', () => {
    const summary = getBatchSummary(samplePayments);
    expect(summary.assetBreakdown['XLM']).toBe(3);
  });

  test('handles multiple assets', () => {
    const payments = [
      {
        address: firstAddress,
        amount: '100',
        asset: 'XLM',
      },
      {
        address: secondAddress,
        amount: '50',
        asset: `USDC:${issuerAddress}`,
      },
    ];
    const summary = getBatchSummary(payments);
    expect(summary.assetBreakdown['XLM']).toBe(1);
    expect(summary.assetBreakdown[`USDC:${issuerAddress}`]).toBe(1);
  });

  test('calculates correct total with decimal amounts', () => {
    const payments = [
      {
        address: firstAddress,
        amount: '10.5',
        asset: 'XLM',
      },
      {
        address: secondAddress,
        amount: '20.25',
        asset: 'XLM',
      },
    ];
    const summary = getBatchSummary(payments);
    expect(summary.totalAmount).toBe('30.75');
  });

  test('preserves valid summary data when an amount is malformed', () => {
    const payments = [
      {
        address: firstAddress,
        amount: '10',
        asset: 'XLM',
      },
      {
        address: secondAddress,
        amount: 'not-a-number',
        asset: 'XLM',
      },
    ];

    const summary = getBatchSummary(payments);

    expect(summary.recipientCount).toBe(2);
    expect(summary.validCount).toBe(1);
    expect(summary.invalidCount).toBe(1);
    expect(summary.totalAmount).toBe('10');
    expect(summary.assetBreakdown['XLM']).toBe(1);
  });

  test('preserves upload row validation for malformed amounts', () => {
    const csv = `address,amount,asset
${firstAddress},10,XLM
${secondAddress},not-a-number,XLM`;
    const parsed = parsePaymentFile(csv, 'csv');
    const summary = getBatchSummary(parsed.rows.map((row) => row.instruction));

    expect(parsed.rows[1].valid).toBe(false);
    expect(parsed.rows[1].error).toContain('positive number');
    expect(summary.totalAmount).toBe('10');
  });

  test('summarizes manual entries without throwing on malformed amounts', () => {
    const parsed = analyzeParsedPayments([
      { address: firstAddress, amount: '10', asset: 'XLM' },
      { address: secondAddress, amount: 'not-a-number', asset: 'XLM' },
    ]);

    expect(() => getBatchSummary(parsed.rows.map((row) => row.instruction))).not.toThrow();
    expect(parsed.rows[1].valid).toBe(false);
    expect(parsed.rows[1].error).toContain('positive number');
  });
});
