// lib/stellar/vesting.ts - Real Soroban SDK integration (#215)
import {
  Contract,
  Networks,
  TransactionBuilder,
  Account,
  xdr,
  Address,
  nativeToScVal,
  StrKey,
} from "stellar-sdk";
import type { PaymentInstruction, Network } from "./types";
import { acquireGuard } from "./reentrancy-guard";
import { amountToStroopsI128, amountToTokenStroopsI128 } from "./utils";

const SOROBAN_RPC_URLS: Record<Network, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-mainnet.stellar.org",
  futurenet: "https://soroban-futurenet.stellar.org",
};

/**
 * Serialize an array of Stellar addresses to ScVal Vec<Address>
 */
function addressVecToScVal(addresses: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(addresses.map((addr) => new Address(addr).toScVal()));
}

/**
 * Serialize an array of already-converted i128 stroop amounts to ScVal Vec<i128>.
 * Callers must resolve each amount's token decimals (via {@link resolveAmountToStroops})
 * before calling this — see #712 for why a single fixed scale is wrong for
 * generic Soroban tokens.
 */
function amountVecToScVal(stroopAmounts: bigint[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    stroopAmounts.map((amt) => nativeToScVal(amt, { type: "i128" })),
  );
}

/**
 * SAC (Stellar Asset Contract) registry for common assets per network.
 * Maps classic CODE:ISSUER → contract address.
 */
const SAC_REGISTRY: Record<Network, Record<string, string>> = {
  testnet: {
    "USDC:GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER":
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    "EURC:GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER":
      "CDVQFCBEBFZ5QPASZ3FRX4K7S2D3JYZ37QRPAAVKBNN5ZPOLMVBPLX7A",
  },
  mainnet: {
    "USDC:GA5ZSEJYB37JRC5AVCKA5M5XTNECMHCGFAJHHHH6R2C5I5SG5C4KFJU2":
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    "EURC:GA5ZSEJYB37JRC5AVCKA5M5XTNECMHCGFAJHHHH6R2C5I5SG5C4KFJU2":
      "CDVQFCBEBFZ5QPASZ3FRX4K7S2D3JYZ37QRPAAVKBNN5ZPOLMVBPLX7A",
  },
  futurenet: {},
};

// Native XLM's wrapped Soroban token address depends on network.
const NATIVE_TOKEN_ADDRESS: Record<Network, string> = {
  testnet: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  mainnet: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  futurenet: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
};

/**
 * Contract addresses that back a classic Stellar asset (native XLM or a
 * registered SAC). A payment whose asset resolves to one of these addresses
 * still uses the fixed 7-decimal Stellar scale even when the caller supplies
 * the C... address directly instead of "XLM" / "CODE:ISSUER" (#712).
 */
const KNOWN_SAC_ADDRESSES: Record<Network, Set<string>> = {
  testnet: new Set([
    NATIVE_TOKEN_ADDRESS.testnet,
    ...Object.values(SAC_REGISTRY.testnet),
  ]),
  mainnet: new Set([
    NATIVE_TOKEN_ADDRESS.mainnet,
    ...Object.values(SAC_REGISTRY.mainnet),
  ]),
  futurenet: new Set([
    NATIVE_TOKEN_ADDRESS.futurenet,
    ...Object.values(SAC_REGISTRY.futurenet),
  ]),
};

/**
 * Convert asset strings to token addresses.
 * Handles 'XLM' (native), C... SAC addresses (passthrough), and 'CODE:ISSUER' (lookup via SAC registry).
 * Throws a clear error for unknown or unresolvable asset strings.
 */
function assetToTokenAddress(asset: string, network: Network): string {
  // Native XLM wrapped address depends on network
  if (asset === "XLM") {
    return NATIVE_TOKEN_ADDRESS[network];
  }

  // Pass through valid C... SAC contract addresses unchanged
  if (StrKey.isValidContract(asset)) {
    return asset;
  }

  // For CODE:ISSUER format, look up SAC registry or return issuer as fallback
  const colonIndex = asset.indexOf(":");
  if (colonIndex > 0) {
    const code = asset.slice(0, colonIndex);
    const issuer = asset.slice(colonIndex + 1);

    // Check SAC registry first
    const registry = SAC_REGISTRY[network] ?? {};
    const contractId = registry[asset];
    if (contractId) return contractId;

    // Fallback: return issuer address (legacy behavior for non-SAC assets)
    if (issuer && StrKey.isValidEd25519PublicKey(issuer)) {
      return issuer;
    }
  }

  throw new Error(
    `Unrecognised asset format: "${asset}". Expected "XLM", a valid C... SAC contract address, or "CODE:ISSUER".`,
  );
}

// In-memory cache of resolved `decimals()` values, keyed by `${network}:${tokenAddress}`.
// Populated once per token for the lifetime of the process (#712).
const tokenDecimalsCache = new Map<string, number>();
// De-dupes concurrent lookups for the same token (e.g. a batch with many
// payments in the same token) so only one RPC round trip is made.
const tokenDecimalsInFlight = new Map<string, Promise<number>>();

/**
 * Calls a Soroban token contract's `decimals()` method over RPC and caches
 * the result per contract address. Concurrent callers for the same token
 * share a single in-flight request instead of firing duplicate simulations.
 */
async function fetchTokenDecimals(
  tokenAddress: string,
  network: Network,
  publicKey: string,
): Promise<number> {
  const cacheKey = `${network}:${tokenAddress}`;
  const cached = tokenDecimalsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const inFlight = tokenDecimalsInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const networkPassphrase =
      network === "mainnet"
        ? Networks.PUBLIC
        : network === "futurenet"
          ? Networks.FUTURENET
          : Networks.TESTNET;
    const rpcUrl = SOROBAN_RPC_URLS[network];

    const { rpc: SorobanRpc, scValToNative } = await import("stellar-sdk");
    const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

    const sourceAccount = await server.getAccount(publicKey);
    const account = new Account(
      sourceAccount.accountId(),
      sourceAccount.sequenceNumber(),
    );

    const contract = new Contract(tokenAddress);
    const tx = new TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase,
    })
      .addOperation(contract.call("decimals"))
      .setTimeout(300)
      .build();

    const simResult = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(
        `Failed to read decimals() for token ${tokenAddress}: ${simResult.error}`,
      );
    }
    if (!simResult.result) {
      throw new Error(
        `Failed to read decimals() for token ${tokenAddress}: simulation returned no result`,
      );
    }

    const decimals = Number(scValToNative(simResult.result.retval));
    tokenDecimalsCache.set(cacheKey, decimals);
    return decimals;
  })();

  tokenDecimalsInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    tokenDecimalsInFlight.delete(cacheKey);
  }
}

/**
 * Converts a human-readable amount string to i128 stroops using the correct
 * decimal scale for `asset`: the fixed 7-decimal Stellar scale for classic
 * assets and known SACs, or the token contract's own `decimals()` for any
 * other Soroban token address (#712).
 */
async function resolveAmountToStroops(
  amount: string,
  asset: string,
  tokenAddress: string,
  network: Network,
  publicKey: string,
): Promise<bigint> {
  const isClassic =
    !StrKey.isValidContract(asset) ||
    KNOWN_SAC_ADDRESSES[network].has(tokenAddress);

  if (isClassic) {
    return amountToStroopsI128(amount);
  }

  const decimals = await fetchTokenDecimals(tokenAddress, network, publicKey);
  return amountToTokenStroopsI128(amount, decimals);
}

async function amountToScVal(
  amount: string,
  asset: string,
  tokenAddress: string,
  network: Network,
  publicKey: string,
): Promise<xdr.ScVal> {
  const stroops = await resolveAmountToStroops(
    amount,
    asset,
    tokenAddress,
    network,
    publicKey,
  );
  return nativeToScVal(stroops, { type: "i128" });
}

async function buildSorobanTransaction(
  contractId: string,
  operation: ReturnType<Contract["call"]>,
  network: Network,
  publicKey: string,
): Promise<string> {
  const networkPassphrase =
    network === "mainnet"
      ? Networks.PUBLIC
      : network === "futurenet"
        ? Networks.FUTURENET
        : Networks.TESTNET;
  const rpcUrl = SOROBAN_RPC_URLS[network];

  const { rpc: SorobanRpc } = await import("stellar-sdk");
  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

  const sourceAccount = await server.getAccount(publicKey);
  const account = new Account(
    sourceAccount.accountId(),
    sourceAccount.sequenceNumber(),
  );

  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(300)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Soroban simulation failed: ${simResult.error}`);
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
  return preparedTx.toEnvelope().toXDR("base64");
}

/**
 * Build an unsigned Soroban deposit transaction XDR.
 * The returned XDR can be signed by Freighter or any other wallet and submitted via Soroban RPC.
 * #210: Supports multiple tokens in a single batch (one token per recipient).
 */
export async function buildDepositTransaction(
  contractId: string,
  payments: PaymentInstruction[],
  startTime: number,
  endTime: number,
  cliffTime: number,
  vestingStep: number,
  network: "testnet" | "mainnet",
  publicKey: string,
): Promise<string> {
  // Reentrancy guard: reject concurrent deposit calls for the same account (#250).
  const release = await acquireGuard(publicKey, "deposit");
  try {
    const networkPassphrase =
      network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    const rpcUrl = SOROBAN_RPC_URLS[network];

    // Dynamically import rpc to keep this tree-shakeable
    const { rpc: SorobanRpc } = await import("stellar-sdk");
    const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

    const sourceAccount = await server.getAccount(publicKey);
    const account = new Account(
      sourceAccount.accountId(),
      sourceAccount.sequenceNumber(),
    );

    const contract = new Contract(contractId);

    // #210: Extract tokens from each payment (one per recipient)
    const tokens = payments.map((p) => assetToTokenAddress(p.asset, network));
    const recipients = payments.map((p) => p.address);
    const memos = payments.map((p) => p.memo || "");

    // #712: Each payment's token may have its own decimal precision (6, 7,
    // 18, ...), so resolve and convert per-payment instead of assuming 7.
    const stroopAmounts = await Promise.all(
      payments.map((p, i) =>
        resolveAmountToStroops(p.amount, p.asset, tokens[i], network, publicKey),
      ),
    );

    const operation = contract.call(
      'deposit',
      new Address(publicKey).toScVal(),          // sender: Address
      addressVecToScVal(tokens),                  // tokens: Vec<Address>
      addressVecToScVal(recipients),              // recipients: Vec<Address>
      amountVecToScVal(stroopAmounts),             // amounts: Vec<i128>
      nativeToScVal(BigInt(startTime), { type: 'u64' }), // start_time: u64
      nativeToScVal(BigInt(endTime), { type: 'u64' }),   // end_time: u64
      nativeToScVal(BigInt(cliffTime), { type: 'u64' }), // cliff_time: u64
      nativeToScVal(BigInt(vestingStep), { type: 'u64' }), // vesting_step: u64
      xdr.ScVal.scvVec(memos.map(m => nativeToScVal(m, { type: 'string' }))) // memos: Vec<String>
    );

    const tx = new TransactionBuilder(account, {
      fee: "1000000", // high fee ceiling; actual fee set after simulation
      networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    // Simulate to populate the Soroban footprint (read/write keys + auth)
    const simResult = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Soroban simulation failed: ${simResult.error}`);
    }

    // Assemble the transaction with the simulated footprint
    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();

    // Return unsigned XDR for wallet signing
    return preparedTx.toEnvelope().toXDR("base64");
  } finally {
    release();
  }
}

/**
 * Build an unsigned transaction to claim from a vesting schedule.
 *
 * `asset` identifies the vesting schedule's token so the claim amount is
 * encoded with that token's own decimal precision instead of always
 * assuming 7 (#712). Defaults to "XLM" to preserve prior behavior for
 * existing callers that don't pass it.
 */
export async function buildClaimTransaction(
  contractId: string,
  recipient: string,
  index: number,
  amount: string,
  network: "testnet" | "mainnet",
  publicKey: string,
  asset: string = "XLM",
): Promise<string> {
  const release = await acquireGuard(publicKey, "claim");
  try {
    const contract = new Contract(contractId);
    const tokenAddress = assetToTokenAddress(asset, network);
    const operation = contract.call(
      "claim",
      new Address(recipient).toScVal(),
      nativeToScVal(BigInt(index), { type: "u32" }),
      await amountToScVal(amount, asset, tokenAddress, network, publicKey),
    );

    return await buildSorobanTransaction(contractId, operation, network, publicKey);
  } finally {
    release();
  }
}

/**
 * Build an unsigned transaction to revoke a vesting schedule.
 */
export async function buildRevokeTransaction(
  contractId: string,
  recipient: string,
  index: number,
  network: "testnet" | "mainnet",
  publicKey: string,
): Promise<string> {
  const release = await acquireGuard(publicKey, "revoke");
  try {
    const contract = new Contract(contractId);
    const operation = contract.call(
      "revoke",
      // The contract signature is `revoke(env, caller, recipient, index)` and the
      // sender authorization is checked against `caller`. Omitting it produces an
      // XDR that does not match the contract interface (#392).
      new Address(publicKey).toScVal(),
      new Address(recipient).toScVal(),
      nativeToScVal(BigInt(index), { type: "u32" }),
    );

    return await buildSorobanTransaction(contractId, operation, network, publicKey);
  } finally {
    release();
  }
}

/** One (recipient, index) pair for {@link buildBatchRevokeTransaction}. */
export interface VestingRevokeRequest {
  recipient: string;
  index: number;
}

/**
 * Encode a contract `RevokeRequest { recipient, index }` as an ScMap.
 * Map keys are sorted alphabetically (`index` before `recipient`) as required
 * by the Soroban XDR encoding rules.
 */
function revokeRequestToScVal(request: VestingRevokeRequest): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("index"),
      val: nativeToScVal(request.index, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("recipient"),
      val: new Address(request.recipient).toScVal(),
    }),
  ]);
}

/**
 * Sort revoke requests so each recipient's indices appear in strictly
 * descending order — required by `batch_revoke` / `revoke_batch` (#308/#505).
 * Recipients are grouped for a stable, deterministic order.
 */
export function sortRevokeRequestsDescending(
  requests: VestingRevokeRequest[],
): VestingRevokeRequest[] {
  return [...requests].sort((a, b) => {
    if (a.recipient !== b.recipient) {
      return a.recipient < b.recipient ? -1 : 1;
    }
    return b.index - a.index;
  });
}

/**
 * Build an unsigned transaction to revoke multiple vesting schedules in one
 * `batch_revoke(caller, requests)` call. Requests are sorted into the
 * strictly-descending-per-recipient order the contract requires.
 */
export async function buildBatchRevokeTransaction(
  contractId: string,
  requests: VestingRevokeRequest[],
  network: "testnet" | "mainnet",
  publicKey: string,
): Promise<string> {
  if (requests.length === 0) {
    throw new Error("batch_revoke requires at least one (recipient, index) pair");
  }

  const release = await acquireGuard(publicKey, "revoke");
  try {
    const sorted = sortRevokeRequestsDescending(requests);
    const contract = new Contract(contractId);
    const operation = contract.call(
      "batch_revoke",
      new Address(publicKey).toScVal(),
      xdr.ScVal.scvVec(sorted.map(revokeRequestToScVal)),
    );

    return await buildSorobanTransaction(contractId, operation, network, publicKey);
  } finally {
    release();
  }
}

/**
 * Build an unsigned transaction to bump the contract instance TTL.
 */
export async function buildBumpInstanceTtlTransaction(
  contractId: string,
  network: "testnet" | "mainnet",
  publicKey: string,
): Promise<string> {
  const release = await acquireGuard(publicKey, "bump");
  try {
    const networkPassphrase =
      network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    const rpcUrl = SOROBAN_RPC_URLS[network];

    const { rpc: SorobanRpc } = await import("stellar-sdk");
    const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

    const sourceAccount = await server.getAccount(publicKey);
    const account = new Account(
      sourceAccount.accountId(),
      sourceAccount.sequenceNumber(),
    );

    const contract = new Contract(contractId);
    const operation = contract.call("bump_instance_ttl");

    const tx = new TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    const simResult = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    return preparedTx.toEnvelope().toXDR("base64");
  } finally {
    release();
  }
}

/**
 * Build an unsigned transaction to transfer vesting rights to a new address.
 * Only the current recipient may authorize this call.
 * The contract does not gate this behind pause flags.
 *
 * Event note: VestingTransferred emits (new_address, old_index) in the payload;
 * the schedule index at the new address is not included until the contract is updated.
 */
export async function buildTransferVestingRightsTransaction(
  contractId: string,
  from: string,
  to: string,
  index: number,
  network: "testnet" | "mainnet",
  publicKey: string,
): Promise<string> {
  const release = await acquireGuard(publicKey, "transfer");
  try {
    const contract = new Contract(contractId);
    const operation = contract.call(
      "transfer_vesting_rights",
      new Address(from).toScVal(),
      nativeToScVal(BigInt(index), { type: "u32" }),
      new Address(to).toScVal(),
    );

    return await buildSorobanTransaction(contractId, operation, network, publicKey);
  } finally {
    release();
  }
}

/**
 * Build an unsigned transaction to bump a specific vesting schedule TTL.
 */
export async function buildBumpVestingTtlTransaction(
  contractId: string,
  recipient: string,
  index: number,
  network: "testnet" | "mainnet",
  publicKey: string,
): Promise<string> {
  const release = await acquireGuard(publicKey, "bump");
  try {
    const networkPassphrase =
      network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    const rpcUrl = SOROBAN_RPC_URLS[network];

    const { rpc: SorobanRpc } = await import("stellar-sdk");
    const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

    const sourceAccount = await server.getAccount(publicKey);
    const account = new Account(
      sourceAccount.accountId(),
      sourceAccount.sequenceNumber(),
    );

    const contract = new Contract(contractId);
    const operation = contract.call(
      "bump_vesting_ttl",
      new Address(recipient).toScVal(),
      nativeToScVal(index, { type: "u32" }),
    );

    const tx = new TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    const simResult = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    return preparedTx.toEnvelope().toXDR("base64");
  } finally {
    release();
  }
}
