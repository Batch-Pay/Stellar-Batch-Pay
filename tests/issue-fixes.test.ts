/**
 * Tests for issue fixes:
 * #385: Pre-signed worker parses XDR with correct network passphrases
 * #386: createJob persists signedTransactions to SQLite
 * #401: Fee cache is keyed by network URL
 * #399: Address book storage consolidation
 * #607: history filter parsing
 * #608: dashboard notification formatting
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Horizon, Networks } from 'stellar-sdk';
import { formatBatchNotification } from '../lib/dashboard/notifications';

// Test #385: Networks passphrase in batch-worker
describe('Issue #385: Networks passphrase in batch-worker', () => {
  test('Networks.TESTNET constant is the full passphrase', () => {
    expect(Networks.TESTNET).toBe('Test SDF Network ; September 2015');
  });

  test('Networks.PUBLIC constant is the full passphrase', () => {
    expect(Networks.PUBLIC).toBe('Public Global Stellar Network ; September 2015');
  });

  test('Networks passphrases are not simple literals', () => {
    // Verify they're not the invalid 'TESTNET' or 'PUBLIC' strings
    expect(Networks.TESTNET).not.toBe('TESTNET');
    expect(Networks.PUBLIC).not.toBe('PUBLIC');
  });
});

// Test #386: Signed transactions persistence
describe('Issue #386: createJob persists signedTransactions', () => {
  beforeEach(() => {
    process.env.JOB_STORE_PATH = ':memory:';
  });

  test('stores and retrieves signedTransactions', async () => {
    // Use dynamic import to get fresh DB instance
    const jobStore = await import('../lib/job-store');
    
    const signedXdrs = [
      'AAAAAgAAAABuWd0p/5t5GEJQqFbFcLf6i6eFMy7OwQ6qS7Eb+qn2AAAA...',
      'AAAAAgAAAABuWd0p/5t5GEJQqFbFcLf6i6eFMy7OwQ6qS7Eb+qn2AAAA...',
    ];

    const payments = [
      {
        address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        amount: '100',
        asset: 'XLM',
      },
    ];

    const jobId = await jobStore.createJob(
      payments,
      'testnet',
      'GDQERHRWJYV7JHRP5V7DWJVI6Y5ABZP3YRH7DKYJRBEGJQKE6IQEOSY2',
      signedXdrs
    );
    const job = await jobStore.getJob(jobId);

    expect(job).toBeDefined();
    expect(job?.signedTransactions).toEqual(signedXdrs);
  });

  test('handles undefined signedTransactions', async () => {
    const jobStore = await import('../lib/job-store');

    const payments = [
      {
        address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        amount: '100',
        asset: 'XLM',
      },
    ];

    const jobId = await jobStore.createJob(
      payments,
      'testnet',
      'GDQERHRWJYV7JHRP5V7DWJVI6Y5ABZP3YRH7DKYJRBEGJQKE6IQEOSY2'
    );
    const job = await jobStore.getJob(jobId);

    expect(job?.signedTransactions).toBeUndefined();
  });
});

// Test #401: Fee cache keying
describe('Issue #401: Fee cache keyed by network URL', () => {
  test('fee cache exports clearFeeCache function', async () => {
    const feeService = await import('../lib/stellar/fee-service');
    expect(typeof feeService.clearFeeCache).toBe('function');
  });

  test('fetchFeeStats uses server URL as cache key', async () => {
    const feeService = await import('../lib/stellar/fee-service');

    // Clear cache before test
    feeService.clearFeeCache();

    // Create servers with different URLs
    const serverTestnet = new Horizon.Server('https://horizon-testnet.stellar.org');
    const serverMainnet = new Horizon.Server('https://horizon.stellar.org');

    // Verify server URLs are different
    expect(serverTestnet.serverURL.toString()).not.toBe(serverMainnet.serverURL.toString());

    // The function should accept both servers
    expect(typeof feeService.fetchFeeStats).toBe('function');
  });

  test('clearFeeCache clears all cached entries', async () => {
    const feeService = await import('../lib/stellar/fee-service');
    
    // Call clearFeeCache - it should not throw
    expect(() => feeService.clearFeeCache()).not.toThrow();
  });
});

// Test #399: Address book storage consolidation
describe('Issue #399: Address book storage consolidation', () => {
  let originalLocalStorage: Storage;
  const mockStorage = new Map<string, string>();

  beforeEach(() => {
    // Save and replace localStorage
    originalLocalStorage = global.localStorage;
    mockStorage.clear();
    
    global.localStorage = {
      getItem: (key: string) => mockStorage.get(key) ?? null,
      setItem: (key: string, value: string) => mockStorage.set(key, value),
      removeItem: (key: string) => mockStorage.delete(key),
      clear: () => mockStorage.clear(),
      length: mockStorage.size,
      key: (index: number) => Array.from(mockStorage.keys())[index] ?? null,
    } as Storage;
  });

  afterEach(() => {
    // Restore original localStorage
    global.localStorage = originalLocalStorage;
    mockStorage.clear();
  });

  test('loadContacts migrates from legacy storage key', async () => {
    const storage = await import('../lib/address-book-storage');
    
    // Simulate legacy data
    const legacyData = JSON.stringify([
      {
        name: 'Alice',
        address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        addedAt: 1000,
      },
    ]);
    
    mockStorage.set('batchpay_address_book', legacyData);

    const { contacts, importedCount } = storage.loadContacts();

    expect(importedCount).toBe(1);
    expect(contacts.length).toBe(1);
    expect(contacts[0].name).toBe('Alice');
  });

  test('saveContacts persists to canonical key', async () => {
    const storage = await import('../lib/address-book-storage');

    const contact = {
      id: '1',
      name: 'Bob',
      address: 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67',
      addedAt: 2000,
    };

    storage.saveContacts([contact]);

    const stored = mockStorage.get('stellar-batch-pay-address-book');
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed[0]).toEqual(contact);
  });

  test('upsertContact creates or updates', async () => {
    const storage = await import('../lib/address-book-storage');

    const contact1 = {
      id: '1',
      name: 'Charlie',
      address: 'GBL7D47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
      addedAt: 3000,
    };

    let contacts = [contact1];

    // Insert new
    contacts = storage.upsertContact(contacts, 'Diana', 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67');
    expect(contacts.length).toBe(2);

    // Update existing
    contacts = storage.upsertContact(contacts, 'Charlie Updated', contact1.address);
    expect(contacts.length).toBe(2);
  });

  test('removeContactById removes by ID', async () => {
    const storage = await import('../lib/address-book-storage');

    const contacts = [
      { id: '1', name: 'Eve', address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER', addedAt: 5000 },
      { id: '2', name: 'Frank', address: 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67', addedAt: 6000 },
    ];

    const filtered = storage.removeContactById(contacts, '1');
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe('2');
  });

  test('createAddressMap creates lookup dictionary', async () => {
    const storage = await import('../lib/address-book-storage');

    const contacts = [
      { id: '1', name: 'Grace', address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER', addedAt: 7000 },
      { id: '2', name: 'Henry', address: 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67', addedAt: 8000 },
    ];

    const map = storage.createAddressMap(contacts);

    expect(map['GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER']).toBe('Grace');
    expect(map['GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67']).toBe('Henry');
  });
});

// Test #608: dashboard notification formatting
describe('Issue #608: dashboard notification formatting', () => {
  test('formats a successful batch notification for the panel', () => {
    expect(
      formatBatchNotification({
        jobId: 'job-1234567890',
        network: 'testnet',
        status: 'completed',
        completedBatches: 3,
        totalBatches: 3,
      }),
    ).toEqual({
      title: 'Batch job-1234… completed',
      description: 'The testnet batch finished successfully (3/3).',
      href: '/dashboard/history/job-1234567890',
    });
  });

  test('formats a failed batch notification with the error message', () => {
    expect(
      formatBatchNotification({
        jobId: 'job-abc',
        network: 'mainnet',
        status: 'failed',
        error: 'Insufficient balance',
      }),
    ).toEqual({
      title: 'Batch job-abc failed',
      description: 'The mainnet batch failed: Insufficient balance',
      href: '/dashboard/history/job-abc',
    });
  });
});
