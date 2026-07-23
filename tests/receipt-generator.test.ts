import { describe, test, expect } from 'vitest';
import { generateReceiptHtml, generateReceiptText } from '../lib/receipt-generator';
import type { BatchResult } from '../lib/stellar/types';

describe('Receipt Generator - Totals by Asset', () => {
  const mockBatchResult: BatchResult = {
    batchId: 'mock-batch-123',
    totalRecipients: 3,
    totalAmount: '35.0000000', // old sum of all (10 + 5 + 20)
    totalTransactions: 2,
    network: 'testnet',
    timestamp: '2026-07-23T15:00:00Z',
    results: [
      {
        recipient: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        amount: '10.0000000',
        asset: 'XLM',
        status: 'success',
        transactionHash: 'hash1',
      },
      {
        recipient: 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67',
        amount: '5.0000000',
        asset: 'XLM',
        status: 'failed',
        error: 'Insufficient funds',
      },
      {
        recipient: 'GBL7D47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        amount: '20.0000000',
        asset: 'USDC:GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        status: 'success',
        transactionHash: 'hash2',
      },
    ],
    summary: {
      successful: 2,
      failed: 1,
    },
  };

  test('generateReceiptHtml calculates totals correctly for successful payments only, grouped by asset', () => {
    const html = generateReceiptHtml(mockBatchResult);
    
    // Total should NOT include the failed 5 XLM payment (total XLM should be 10.0000000, USDC should be 20.0000000)
    expect(html).toContain('10.0000000 XLM');
    expect(html).toContain('20.0000000 USDC:GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER');
    expect(html).not.toContain('35.0000000');
    expect(html).not.toContain('15.0000000 XLM');
  });

  test('generateReceiptText calculates totals correctly for successful payments only, grouped by asset', () => {
    const text = generateReceiptText(mockBatchResult);

    expect(text).toContain('Total Amount: 10.0000000 XLM, 20.0000000 USDC:GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER');
    expect(text).not.toContain('35.0000000');
    expect(text).not.toContain('15.0000000 XLM');
  });
});
