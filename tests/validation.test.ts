/**
 * Test suite for validation functions
 * Run with: npx jest tests/
 */

import { Keypair } from 'stellar-sdk';

import {
  validatePaymentInstruction,
  validateBatchConfig,
  validatePaymentInstructions,
  validateMemo,
  validateBatchForSubmit,
} from '../lib/stellar/validator';

const validSecretKey = Keypair.random().secret();
const validAddress = Keypair.random().publicKey();
const secondValidAddress = Keypair.random().publicKey();
const validIssuer = Keypair.random().publicKey();
const invalidChecksumAddress = `${validAddress.slice(0, -1)}${validAddress.endsWith('A') ? 'B' : 'A'}`;
const invalidChecksumIssuer = `${validIssuer.slice(0, -1)}${validIssuer.endsWith('A') ? 'B' : 'A'}`;

describe('Payment Instruction Validation', () => {
  test('validates correct XLM payment', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '100.50',
      asset: 'XLM',
    });
    expect(result.valid).toBe(true);
  });

  test('validates correct issued asset payment', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '50.25',
      asset: `USDC:${validIssuer}`,
    });
    expect(result.valid).toBe(true);
  });

  test('rejects invalid address', () => {
    const result = validatePaymentInstruction({
      address: 'INVALID_ADDRESS',
      amount: '100',
      asset: 'XLM',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('address');
  });

  test('rejects address with invalid checksum', () => {
    const result = validatePaymentInstruction({
      address: invalidChecksumAddress,
      amount: '100',
      asset: 'XLM',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('checksum');
  });

  test('rejects negative amount', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '-100',
      asset: 'XLM',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('amount');
  });

  test('rejects zero amount', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '0',
      asset: 'XLM',
    });
    expect(result.valid).toBe(false);
  });

  test('rejects invalid asset format', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '100',
      asset: 'INVALID',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('asset');
  });

  test('rejects asset issuer with invalid checksum', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '100',
      asset: `USDC:${invalidChecksumIssuer}`,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('checksum');
  });
});

describe('Asset Code Alphanumeric Validation', () => {
  test('rejects asset code with a space ("BAD CODE")', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '10',
      asset: `BAD CODE:${validIssuer}`,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/alphanumeric/i);
  });

  test('rejects asset code with a hyphen ("BAD-CODE")', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '10',
      asset: `BAD-CODE:${validIssuer}`,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/alphanumeric/i);
  });

  test('rejects asset code with an underscore ("BAD_CODE")', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '10',
      asset: `BAD_CODE:${validIssuer}`,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/alphanumeric/i);
  });

  test('rejects asset code with a special character ("USD$")', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '10',
      asset: `USD$:${validIssuer}`,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/alphanumeric/i);
  });

  test('accepts a 1-character alphanumeric code ("X")', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '10',
      asset: `X:${validIssuer}`,
    });
    expect(result.valid).toBe(true);
  });

  test('accepts a mixed-case alphanumeric code ("UsDc")', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '10',
      asset: `UsDc:${validIssuer}`,
    });
    expect(result.valid).toBe(true);
  });

  test('accepts a 12-character alphanumeric code at max length', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '10',
      asset: `ABCDEFGH1234:${validIssuer}`,
    });
    expect(result.valid).toBe(true);
  });

  test('accepts a numeric-only code ("1234")', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '10',
      asset: `1234:${validIssuer}`,
    });
    expect(result.valid).toBe(true);
  });
});

describe('Memo Validation', () => {
  test('validates valid text memo', () => {
    const result = validateMemo('Hello World', 'text');
    expect(result.valid).toBe(true);
  });

  test('validates text memo at exactly 28 bytes', () => {
    const memo = 'a'.repeat(28);
    const result = validateMemo(memo, 'text');
    expect(result.valid).toBe(true);
  });

  test('rejects text memo exceeding 28 bytes', () => {
    const memo = 'a'.repeat(29);
    const result = validateMemo(memo, 'text');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('28 bytes');
  });

  test('rejects multi-byte text memo exceeding 28 bytes', () => {
    // Each emoji is 4 bytes, so 8 emojis = 32 bytes > 28
    const memo = '😀😀😀😀😀😀😀😀';
    const result = validateMemo(memo, 'text');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('28 bytes');
  });

  test('validates valid memo ID', () => {
    const result = validateMemo('12345', 'id');
    expect(result.valid).toBe(true);
  });

  test('validates memo ID zero', () => {
    const result = validateMemo('0', 'id');
    expect(result.valid).toBe(true);
  });

  test('rejects non-integer memo ID', () => {
    const result = validateMemo('abc', 'id');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid integer');
  });

  test('rejects negative memo ID', () => {
    const result = validateMemo('-1', 'id');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid integer');
  });

  test('rejects decimal memo ID', () => {
    const result = validateMemo('12.5', 'id');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid integer');
  });

  // #554 — u64 boundary validation
  test('accepts u64 max value (18446744073709551615)', () => {
    const result = validateMemo('18446744073709551615', 'id');
    expect(result.valid).toBe(true);
  });

  test('accepts u64 min value (0)', () => {
    const result = validateMemo('0', 'id');
    expect(result.valid).toBe(true);
  });

  test('rejects u64 max + 1 (18446744073709551616)', () => {
    const result = validateMemo('18446744073709551616', 'id');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('64-bit');
  });

  test('rejects negative memo ID string', () => {
    const result = validateMemo('-5', 'id');
    expect(result.valid).toBe(false);
  });

  test('validates memo type none', () => {
    const result = validateMemo('anything', 'none');
    expect(result.valid).toBe(true);
  });

  test('validates empty memo', () => {
    const result = validateMemo('', 'text');
    expect(result.valid).toBe(true);
  });
});

describe('Payment Instruction Memo Validation', () => {
  test('validates payment with valid text memo', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '100',
      asset: 'XLM',
      memo: 'Payment ref',
      memoType: 'text',
    });
    expect(result.valid).toBe(true);
  });

  test('validates payment with valid ID memo', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '100',
      asset: 'XLM',
      memo: '99999',
      memoType: 'id',
    });
    expect(result.valid).toBe(true);
  });

  test('rejects payment with memo text exceeding 28 bytes', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '100',
      asset: 'XLM',
      memo: 'a'.repeat(29),
      memoType: 'text',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('28 bytes');
  });

  test('rejects payment with invalid memo ID', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '100',
      asset: 'XLM',
      memo: 'not-a-number',
      memoType: 'id',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid integer');
  });

  test('defaults to text memo type when not specified', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '100',
      asset: 'XLM',
      memo: 'Short memo',
    });
    expect(result.valid).toBe(true);
  });

  test('validates payment without memo', () => {
    const result = validatePaymentInstruction({
      address: validAddress,
      amount: '100',
      asset: 'XLM',
    });
    expect(result.valid).toBe(true);
  });
});

describe('Batch Configuration Validation', () => {
  test('validates correct config', () => {
    const result = validateBatchConfig({
      secretKey: validSecretKey,
      network: 'testnet',
      maxOperationsPerTransaction: 50,
    });
    expect(result.valid).toBe(true);
  });

  test('rejects invalid secret key', () => {
    const result = validateBatchConfig({
      secretKey: 'INVALID_SECRET',
      network: 'testnet',
      maxOperationsPerTransaction: 50,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('secret key');
  });

  test('rejects invalid network', () => {
    const result = validateBatchConfig({
      secretKey: validSecretKey,
      network: 'invalid' as any,
      maxOperationsPerTransaction: 50,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('network');
  });

  test('rejects excessive operations per transaction', () => {
    const result = validateBatchConfig({
      secretKey: validSecretKey,
      network: 'testnet',
      maxOperationsPerTransaction: 200,
    });
    expect(result.valid).toBe(false);
  });
});

describe('Batch Validation', () => {
  test('validates batch of correct payments', () => {
    const result = validatePaymentInstructions([
      {
        address: validAddress,
        amount: '100',
        asset: 'XLM',
      },
      {
        address: secondValidAddress,
        amount: '50',
        asset: 'XLM',
      },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors.size).toBe(0);
  });

  test('detects errors in batch', () => {
    const result = validatePaymentInstructions([
      {
        address: validAddress,
        amount: '100',
        asset: 'XLM',
      },
      {
        address: 'INVALID',
        amount: '50',
        asset: 'XLM',
      },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.size).toBe(1);
    expect(result.errors.has(1)).toBe(true);
  });
});

describe('validateBatchForSubmit', () => {
  test('validates correct batch submission', () => {
    const result = validateBatchForSubmit(
      [
        {
          address: validAddress,
          amount: '100',
          asset: 'XLM',
        },
      ],
      { XLM: 200 },
      [],
      'testnet',
    );
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test('reports insufficient XLM balance', () => {
    const result = validateBatchForSubmit(
      [
        {
          address: validAddress,
          amount: '100',
          asset: 'XLM',
        },
      ],
      { XLM: 50 },
      [],
      'testnet',
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Insufficient balance for XLM. Required: 100');
  });

  test('reports missing trustline warnings', () => {
    const result = validateBatchForSubmit(
      [
        {
          address: validAddress,
          amount: '100',
          asset: `USDC:${validIssuer}`,
        },
      ],
      { [`USDC:${validIssuer}`]: 200 },
      [validAddress],
      'testnet',
    );
    expect(result.valid).toBe(true); // missing trustline is only a warning
    expect(result.warnings.join(' ')).toContain('missing trustline');
  });
});
