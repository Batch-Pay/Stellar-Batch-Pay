/**
 * Regression tests for #712: Soroban vesting amounts must use each token's
 * actual `decimals()` value instead of always assuming the classic 7-decimal
 * Stellar scale. A fixed 7-decimal scale silently over- or under-encodes
 * amounts for tokens with a different decimal count (e.g. 6 or 18), which
 * can lock or transfer significantly more/less than the user intended.
 *
 * We mock Soroban RPC's `getAccount` + `simulateTransaction` so the test
 * doesn't touch the network. `simulateTransaction` additionally recognises a
 * `decimals()` invocation and returns a per-contract canned result, tracking
 * how many times each contract's `decimals()` was actually simulated so we
 * can assert the caching/de-dup behaviour required by #712.
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Contract, Keypair, StrKey, xdr, scValToNative } from 'stellar-sdk';
import type { PaymentInstruction } from '../lib/stellar/types';
import { ExcessTokenPrecisionError } from '../lib/stellar/utils';

const VALID_CONTRACT_ID =
  'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ';

// Generic (non-SAC) Soroban token contract addresses used across tests.
// These are not present in vesting.ts's SAC registry, so they must go
// through the dynamic decimals() lookup path.
const TOKEN_6_DECIMALS = StrKey.encodeContract(Buffer.alloc(32, 0x11));
const TOKEN_18_DECIMALS = StrKey.encodeContract(Buffer.alloc(32, 0x22));
const TOKEN_7_DECIMALS = StrKey.encodeContract(Buffer.alloc(32, 0x33));
// `vesting.ts` caches decimals() per contract address for the process
// lifetime, so the caching tests below use their own addresses that no
// other test in this file resolves — otherwise an earlier test's lookup
// would already have warmed the cache before we assert the call count.
const TOKEN_CACHE_TEST_BATCH = StrKey.encodeContract(Buffer.alloc(32, 0x44));
const TOKEN_CACHE_TEST_REPEAT = StrKey.encodeContract(Buffer.alloc(32, 0x55));

type MockState = {
  decimalsByContract: Record<string, number>;
  decimalsCallCount: Record<string, number>;
};

// --- Mock the Soroban RPC surface --------------------------------

vi.mock('stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('stellar-sdk')>();

  const mockState: MockState = {
    decimalsByContract: {},
    decimalsCallCount: {},
  };

  class FakeServer {
    constructor(_url: string, _opts?: { allowHttp?: boolean }) {}

    async getAccount(id: string) {
      return new actual.Account(id, '12345');
    }

    async simulateTransaction(tx: {
      operations: Array<{ type: string; func?: xdr.HostFunction }>;
    }) {
      const op = tx.operations[0];
      if (
        op?.type === 'invokeHostFunction' &&
        op.func?.switch().name === 'hostFunctionTypeInvokeContract'
      ) {
        const invocation = op.func.invokeContract();
        if (invocation.functionName().toString() === 'decimals') {
          const contractId = actual.StrKey.encodeContract(
            invocation.contractAddress().contractId(),
          );
          mockState.decimalsCallCount[contractId] =
            (mockState.decimalsCallCount[contractId] ?? 0) + 1;
          const decimals = mockState.decimalsByContract[contractId] ?? 7;
          return {
            transactionData: { resourceFee: () => 100n },
            minResourceFee: '100',
            latestLedger: 1,
            result: {
              retval: actual.nativeToScVal(decimals, { type: 'u32' }),
              auth: [],
            },
          };
        }
      }

      return {
        transactionData: { resourceFee: () => 100n },
        minResourceFee: '100',
        latestLedger: 1,
      };
    }
  }

  const assembleTransaction = vi.fn((tx: unknown) => ({
    build: () => tx,
  }));

  const isSimulationError = vi.fn(() => false);

  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: FakeServer,
      assembleTransaction,
      Api: {
        ...(actual.rpc?.Api ?? {}),
        isSimulationError,
      },
    },
    __mockState: mockState,
  };
});

// --- Helpers -----------------------------------------------------

function payment(addr: string, amount: string, asset: string): PaymentInstruction {
  return { address: addr, amount, asset };
}

async function getMockState(): Promise<MockState> {
  const sdk = (await import('stellar-sdk')) as unknown as {
    __mockState: MockState;
  };
  return sdk.__mockState;
}

beforeEach(async () => {
  vi.clearAllMocks();
  const state = await getMockState();
  state.decimalsByContract = {
    [TOKEN_6_DECIMALS]: 6,
    [TOKEN_18_DECIMALS]: 18,
    [TOKEN_7_DECIMALS]: 7,
    [TOKEN_CACHE_TEST_BATCH]: 6,
    [TOKEN_CACHE_TEST_REPEAT]: 6,
  };
  state.decimalsCallCount = {};
});

// --- Tests -------------------------------------------------------

describe('buildDepositTransaction — token-specific decimals (#712)', () => {
  test('6-decimal token: "1" encodes to 1_000_000 stroops', async () => {
    const callSpy = vi.spyOn(Contract.prototype, 'call');
    const { buildDepositTransaction } = await import('../lib/stellar/vesting');
    const sender = Keypair.random().publicKey();

    const payments = [payment(Keypair.random().publicKey(), '1', TOKEN_6_DECIMALS)];

    await buildDepositTransaction(
      VALID_CONTRACT_ID,
      payments,
      1_700_000_000,
      1_800_000_000,
      86_400,
      86_400,
      'testnet',
      sender,
    );

    const depositCall = callSpy.mock.calls.find(([fn]) => fn === 'deposit')!;
    const amountsVec = depositCall[4] as xdr.ScVal;
    expect(scValToNative(amountsVec)).toEqual([1_000_000n]);
    callSpy.mockRestore();
  });

  test('7-decimal token: "1" encodes to 10_000_000 stroops', async () => {
    const callSpy = vi.spyOn(Contract.prototype, 'call');
    const { buildDepositTransaction } = await import('../lib/stellar/vesting');
    const sender = Keypair.random().publicKey();

    const payments = [payment(Keypair.random().publicKey(), '1', TOKEN_7_DECIMALS)];

    await buildDepositTransaction(
      VALID_CONTRACT_ID,
      payments,
      1_700_000_000,
      1_800_000_000,
      86_400,
      86_400,
      'testnet',
      sender,
    );

    const depositCall = callSpy.mock.calls.find(([fn]) => fn === 'deposit')!;
    const amountsVec = depositCall[4] as xdr.ScVal;
    expect(scValToNative(amountsVec)).toEqual([10_000_000n]);
    callSpy.mockRestore();
  });

  test('18-decimal token: "1" encodes to 1_000_000_000_000_000_000 stroops', async () => {
    const callSpy = vi.spyOn(Contract.prototype, 'call');
    const { buildDepositTransaction } = await import('../lib/stellar/vesting');
    const sender = Keypair.random().publicKey();

    const payments = [payment(Keypair.random().publicKey(), '1', TOKEN_18_DECIMALS)];

    await buildDepositTransaction(
      VALID_CONTRACT_ID,
      payments,
      1_700_000_000,
      1_800_000_000,
      86_400,
      86_400,
      'testnet',
      sender,
    );

    const depositCall = callSpy.mock.calls.find(([fn]) => fn === 'deposit')!;
    const amountsVec = depositCall[4] as xdr.ScVal;
    expect(scValToNative(amountsVec)).toEqual([1_000_000_000_000_000_000n]);
    callSpy.mockRestore();
  });

  test('mixed batch: each payment is scaled by its own token decimals', async () => {
    const callSpy = vi.spyOn(Contract.prototype, 'call');
    const { buildDepositTransaction } = await import('../lib/stellar/vesting');
    const sender = Keypair.random().publicKey();

    const payments = [
      payment(Keypair.random().publicKey(), '1', TOKEN_6_DECIMALS),
      payment(Keypair.random().publicKey(), '2', 'XLM'),
      payment(Keypair.random().publicKey(), '1', TOKEN_18_DECIMALS),
    ];

    await buildDepositTransaction(
      VALID_CONTRACT_ID,
      payments,
      1_700_000_000,
      1_800_000_000,
      86_400,
      86_400,
      'testnet',
      sender,
    );

    const depositCall = callSpy.mock.calls.find(([fn]) => fn === 'deposit')!;
    const amountsVec = depositCall[4] as xdr.ScVal;
    expect(scValToNative(amountsVec)).toEqual([
      1_000_000n,
      20_000_000n, // XLM: classic 7-decimal scale
      1_000_000_000_000_000_000n,
    ]);
    callSpy.mockRestore();
  });

  test('rejects amounts with more decimal places than the token supports', async () => {
    const { buildDepositTransaction } = await import('../lib/stellar/vesting');
    const sender = Keypair.random().publicKey();

    // TOKEN_6_DECIMALS supports 6 fractional digits; this amount has 7.
    const payments = [
      payment(Keypair.random().publicKey(), '0.1234567', TOKEN_6_DECIMALS),
    ];

    await expect(
      buildDepositTransaction(
        VALID_CONTRACT_ID,
        payments,
        1_700_000_000,
        1_800_000_000,
        86_400,
        86_400,
        'testnet',
        sender,
      ),
    ).rejects.toThrow(ExcessTokenPrecisionError);
  });

  test('classic XLM and known SAC assets never trigger a decimals() RPC call', async () => {
    const { buildDepositTransaction } = await import('../lib/stellar/vesting');
    const sender = Keypair.random().publicKey();
    const sacAddress = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';

    const payments = [
      payment(Keypair.random().publicKey(), '10', 'XLM'),
      payment(Keypair.random().publicKey(), '10', sacAddress),
      payment(
        Keypair.random().publicKey(),
        '10',
        'USDC:GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
      ),
    ];

    await buildDepositTransaction(
      VALID_CONTRACT_ID,
      payments,
      1_700_000_000,
      1_800_000_000,
      86_400,
      86_400,
      'testnet',
      sender,
    );

    const state = await getMockState();
    expect(state.decimalsCallCount).toEqual({});
  });

  test('caches decimals() per token: repeated payments in the same token only call RPC once', async () => {
    const { buildDepositTransaction } = await import('../lib/stellar/vesting');
    const sender = Keypair.random().publicKey();

    const payments = [
      payment(Keypair.random().publicKey(), '1', TOKEN_CACHE_TEST_BATCH),
      payment(Keypair.random().publicKey(), '2', TOKEN_CACHE_TEST_BATCH),
      payment(Keypair.random().publicKey(), '3', TOKEN_CACHE_TEST_BATCH),
    ];

    await buildDepositTransaction(
      VALID_CONTRACT_ID,
      payments,
      1_700_000_000,
      1_800_000_000,
      86_400,
      86_400,
      'testnet',
      sender,
    );

    const state = await getMockState();
    expect(state.decimalsCallCount[TOKEN_CACHE_TEST_BATCH]).toBe(1);
  });

  test('caches decimals() across separate buildDepositTransaction calls', async () => {
    const { buildDepositTransaction } = await import('../lib/stellar/vesting');
    const sender = Keypair.random().publicKey();

    for (let i = 0; i < 2; i++) {
      await buildDepositTransaction(
        VALID_CONTRACT_ID,
        [payment(Keypair.random().publicKey(), '1', TOKEN_CACHE_TEST_REPEAT)],
        1_700_000_000,
        1_800_000_000,
        86_400,
        86_400,
        'testnet',
        sender,
      );
    }

    const state = await getMockState();
    expect(state.decimalsCallCount[TOKEN_CACHE_TEST_REPEAT]).toBe(1);
  });
});

describe('buildClaimTransaction — token-specific decimals (#712)', () => {
  test('claim amount for a 6-decimal token is scaled by 10^6, not 10^7', async () => {
    const callSpy = vi.spyOn(Contract.prototype, 'call');
    const { buildClaimTransaction } = await import('../lib/stellar/vesting');

    const recipient = Keypair.random().publicKey();
    const signer = Keypair.random().publicKey();

    await buildClaimTransaction(
      VALID_CONTRACT_ID,
      recipient,
      0,
      '1',
      'testnet',
      signer,
      TOKEN_6_DECIMALS,
      // The mocked assembled-transaction pipeline doesn't fully round-trip
      // through a real Soroban RPC, so swallow the downstream XDR error —
      // we only need to assert the args handed to `contract.call`.
    ).catch(() => undefined);

    const claimCall = callSpy.mock.calls.find(([fn]) => fn === 'claim')!;
    const [, , , amountArg] = claimCall;
    expect(scValToNative(amountArg as xdr.ScVal)).toBe(1_000_000n);
    callSpy.mockRestore();
  });

  test('claim defaults to XLM (7-decimal) when asset is omitted', async () => {
    const callSpy = vi.spyOn(Contract.prototype, 'call');
    const { buildClaimTransaction } = await import('../lib/stellar/vesting');

    const recipient = Keypair.random().publicKey();
    const signer = Keypair.random().publicKey();

    await buildClaimTransaction(
      VALID_CONTRACT_ID,
      recipient,
      0,
      '1',
      'testnet',
      signer,
    ).catch(() => undefined);

    const claimCall = callSpy.mock.calls.find(([fn]) => fn === 'claim')!;
    const [, , , amountArg] = claimCall;
    expect(scValToNative(amountArg as xdr.ScVal)).toBe(10_000_000n);
    callSpy.mockRestore();
  });
});
