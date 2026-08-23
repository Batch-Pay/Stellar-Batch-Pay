/**
 * Test suite for balance validation functions
 */

import { buildBalancesMap, resolveAssetKey, validateBalances } from '../lib/stellar/validator';
import type { HorizonBalance, PaymentInstruction } from '../lib/stellar/types';

import { Keypair } from 'stellar-sdk';

const validIssuer = Keypair.random().publicKey();
const validAddress = Keypair.random().publicKey();

const mockBalances: HorizonBalance[] = [
  { asset_type: 'native', balance: '103.0000100' },
  { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: validIssuer, balance: '500.0000000' },
];

describe('buildBalancesMap', () => {
  test('maps native asset as XLM', () => {
    const map = buildBalancesMap(mockBalances);
    expect(map.XLM).toBe(103.00001);
  });

  test('maps non-native assets as CODE:ISSUER', () => {
    const map = buildBalancesMap(mockBalances);
    expect(map[`USDC:${validIssuer}`]).toBe(500);
  });

  test('subtracts selling liabilities from spendable issued-asset balances', () => {
    const map = buildBalancesMap([
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: validIssuer,
        balance: '100.0000000',
        selling_liabilities: '90.0000000',
      },
    ]);

    expect(map[`USDC:${validIssuer}`]).toBe(10);
  });

  test('returns empty map for empty balances', () => {
    const map = buildBalancesMap([]);
    expect(Object.keys(map)).toHaveLength(0);
  });
});

describe('resolveAssetKey', () => {
  test('returns XLM for native asset', () => {
    expect(resolveAssetKey('XLM')).toBe('XLM');
  });

  test('returns CODE:ISSUER as-is for non-native asset', () => {
    expect(resolveAssetKey(`USDC:${validIssuer}`)).toBe(`USDC:${validIssuer}`);
  });
});

describe('validateBalances', () => {
  const balancesMap = buildBalancesMap(mockBalances);

  test('sufficient XLM payment passes', () => {
    const payments: PaymentInstruction[] = [
      { address: validAddress, amount: '50', asset: 'XLM' },
    ];
    const result = validateBalances(payments, balancesMap);
    expect(result.all_sufficient).toBe(true);
    expect(result.checks[0].sufficient).toBe(true);
  });

  test('sufficient non-native payment passes', () => {
    const payments: PaymentInstruction[] = [
      { address: validAddress, amount: '200', asset: `USDC:${validIssuer}` },
    ];
    const result = validateBalances(payments, balancesMap);
    expect(result.all_sufficient).toBe(true);
  });

  test('insufficient balance fails', () => {
    const payments: PaymentInstruction[] = [
      { address: validAddress, amount: '999', asset: `USDC:${validIssuer}` },
    ];
    const result = validateBalances(payments, balancesMap);
    expect(result.all_sufficient).toBe(false);
    expect(result.checks[0].sufficient).toBe(false);
    expect(result.checks[0].available).toBe(500);
    expect(result.checks[0].required).toBe(999);
  });

  test('issued-asset selling liabilities prevent overstating available funds', () => {
    const balancesWithLiabilities = buildBalancesMap([
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: validIssuer,
        balance: '100.0000000',
        selling_liabilities: '90.0000000',
      },
    ]);
    const payments: PaymentInstruction[] = [
      { address: validAddress, amount: '20', asset: `USDC:${validIssuer}` },
    ];

    const result = validateBalances(payments, balancesWithLiabilities);

    expect(result.all_sufficient).toBe(false);
    expect(result.checks[0].available).toBe(10);
    expect(result.checks[0].required).toBe(20);
  });

  test('missing trustline treated as zero balance', () => {
    const payments: PaymentInstruction[] = [
      { address: validAddress, amount: '1', asset: `BTC:${validIssuer}` },
    ];
    const result = validateBalances(payments, balancesMap);
    expect(result.all_sufficient).toBe(false);
    expect(result.checks[0].available).toBe(0);
  });

  test('aggregates cumulative payments of the same asset', () => {
    const payments: PaymentInstruction[] = [
      { address: validAddress, amount: '60', asset: 'XLM' },
      { address: validAddress, amount: '60', asset: 'XLM' },
    ];
    const result = validateBalances(payments, balancesMap);
    expect(result.all_sufficient).toBe(false);
    expect(result.checks[0].required).toBe(120);
  });

  test('validates mixed assets independently', () => {
    const payments: PaymentInstruction[] = [
      { address: validAddress, amount: '50', asset: 'XLM' },
      { address: validAddress, amount: '999', asset: `USDC:${validIssuer}` },
    ];
    const result = validateBalances(payments, balancesMap);
    expect(result.all_sufficient).toBe(false);
    const xlm = result.checks.find(c => c.asset_key === 'XLM');
    const usdc = result.checks.find(c => c.asset_key.startsWith('USDC'));
    expect(xlm?.sufficient).toBe(true);
    expect(usdc?.sufficient).toBe(false);
  });

  test('all sufficient with exact balance', () => {
    const payments: PaymentInstruction[] = [
      { address: validAddress, amount: '100', asset: 'XLM' },
      { address: validAddress, amount: '500', asset: `USDC:${validIssuer}` },
    ];
    const result = validateBalances(payments, balancesMap);
    expect(result.all_sufficient).toBe(true);
  });

  test('XLM reserve reflects subentries and sponsorship instead of a fixed 2 XLM floor', () => {
    const payments: PaymentInstruction[] = [
      { address: validAddress, amount: '6', asset: 'XLM' },
    ];
    const result = validateBalances(payments, { XLM: 10 }, 1, 100, {
      baseReserveXlm: 0.5,
      subentryCount: 8,
      numSponsoring: 2,
      numSponsored: 1,
    });

    expect(result.all_sufficient).toBe(false);
    expect(result.checks[0].xlm_reserved).toBeCloseTo(5.50001);
    expect(result.checks[0].xlm_available_after_reserve).toBeCloseTo(4.49999);
  });
});
