// scripts/keeper.ts
import { pathToFileURL } from "node:url";
import {
  rpc as SorobanRpc,
  Horizon,
  Networks,
  Keypair,
  TransactionBuilder,
  Account,
  Contract,
  Address,
  nativeToScVal,
} from "stellar-sdk";
import { prioritizeRecipients } from "../lib/keeper/threshold";
import { createSecretsProvider } from "../lib/secrets/index";
import {
  decodeTopicValue,
  parseVestingEventRecipient,
} from "../lib/stellar/vesting-events";

/**
 * CONFIGURATION
 */
const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const CONTRACT_ID = process.env.CONTRACT_ID;
const U32_MAX = 2 ** 32 - 1;
const MAINTENANCE_LIMIT = readU32Env("MAINTENANCE_LIMIT", 10);
const BUMP_THRESHOLD_DAYS = 7;
const LEDGERS_PER_DAY = 17280; // ~5 s per ledger on Stellar
const BUMP_THRESHOLD_LEDGERS = BUMP_THRESHOLD_DAYS * LEDGERS_PER_DAY;
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
const LOW_BALANCE_THRESHOLD = Number(process.env.LOW_BALANCE_THRESHOLD || "50"); // XLM

// State file path for persisting per-recipient pagination index across runs (#586).
const STATE_FILE_PATH =
  process.env.KEEPER_STATE_PATH || "./data/keeper-state.json";

if (!CONTRACT_ID && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error("MISSING CONTRACT_ID in environment");
  process.exit(1);
}

function readU32Env(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new Error(`${name} must be an unsigned 32-bit integer`);
  }

  return value;
}

// ── Per-recipient pagination state (#586) ─────────────────────────────────

interface KeeperState {
  nextMaintenanceIndex: Record<string, number>;
}

async function loadState(): Promise<KeeperState> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(STATE_FILE_PATH, "utf-8");
    return JSON.parse(raw) as KeeperState;
  } catch {
    return { nextMaintenanceIndex: {} };
  }
}

async function saveState(state: KeeperState): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(STATE_FILE_PATH), { recursive: true });
  await writeFile(STATE_FILE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// ── Alerts & balance ───────────────────────────────────────────────────────

async function sendAlert(message: string) {
  console.log(`[ALERT] ${message}`);
  if (!ALERT_WEBHOOK_URL) return;

  try {
    const response = await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `🚨 *Keeper Bot Alert*: ${message}` }),
    });
    if (!response.ok) {
      console.error("Failed to send alert to webhook:", response.statusText);
    }
  } catch (error) {
    console.error("Error sending alert:", error);
  }
}

async function checkBalance(_server: SorobanRpc.Server, publicKey: string) {
  try {
    const horizonServer = new Horizon.Server(
      NETWORK_PASSPHRASE === Networks.PUBLIC
        ? "https://horizon.stellar.org"
        : "https://horizon-testnet.stellar.org",
    );
    const account = await horizonServer.loadAccount(publicKey);
    const nativeEntry = account.balances.find(
      (b) => b.asset_type === "native",
    );
    const balance = Number(nativeEntry?.balance ?? "0");

    if (balance < LOW_BALANCE_THRESHOLD) {
      await sendAlert(
        `Low balance warning! Sponsor wallet ${publicKey} has only ${balance} XLM remaining.`,
      );
    }
  } catch (error) {
    console.error("Failed to check balance:", error);
  }
}

export function getNextPageCursor(response: { cursor?: string | null; latestLedger?: number | null } | undefined): string | undefined {
  if (!response) return undefined;
  return typeof response.cursor === "string" && response.cursor.length > 0
    ? response.cursor
    : undefined;
}

export function determineMaintenanceState(
  status: "bumped" | "no-work" | "pending" | "failed",
): "advance" | "reset" | "hold" {
  switch (status) {
    case "bumped":
      return "advance";
    case "no-work":
      return "reset";
    case "pending":
    case "failed":
      return "hold";
    default:
      return "hold";
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────

export async function main() {
  // Fetch the keeper secret from the configured backend (#257).
  // Set SECRET_BACKEND=aws|github|env (default: env with a warning).
  const secrets = await createSecretsProvider();
  const keeperSecret = await secrets.fetchSecret("KEEPER_SECRET");
  const keeperKeypair = Keypair.fromSecret(keeperSecret);
  const server = new SorobanRpc.Server(RPC_URL);
  const contract = new Contract(CONTRACT_ID!);

  console.log("Starting Keeper Bot...");
  console.log(`Contract: ${CONTRACT_ID}`);
  console.log(`Keeper: ${keeperKeypair.publicKey()}`);
  console.log(`Bump threshold: ${BUMP_THRESHOLD_DAYS} day(s) (${BUMP_THRESHOLD_LEDGERS} ledgers)`);

  const state = await loadState();

  try {
    // 1. Fetch active recipients from events (simplified: assume we have a list or indexer)
    // In a production scenario, you would use an indexer or query events.
    // For this demonstration, we'll focus on the logic for a single recipient.
    const recipients = await fetchActiveRecipients();

    if (recipients.length === 0) {
      await sendAlert(
        "No active recipients were discovered from contract events; keeper may be missing vesting entries.",
      );
    }

    const currentLedger = (await server.getLatestLedger()).sequence;
    const orderedRecipients = prioritizeRecipients(
      recipients.map((recipient) => ({ recipient, liveUntilLedger: null })),
      currentLedger,
      BUMP_THRESHOLD_LEDGERS,
    ).map((snapshot) => snapshot.recipient);
    for (const recipient of [...new Set([...orderedRecipients, ...recipients])]) {
      await maintainRecipientPaginated(
        recipient,
        server,
        contract,
        keeperKeypair,
        state,
      );
      // Reload account sequence after each recipient to prevent TX_BAD_SEQ
      // when processing multiple recipients sequentially
      await server.getAccount(keeperKeypair.publicKey());
    }

    await saveState(state);

    // 2. Maintain contract instance
    await maintainInstance(server, contract, keeperKeypair);

    // 4. Proactive balance check
    await checkBalance(server, keeperKeypair.publicKey());

    console.log("Keeper Bot finished successfully.");
    process.exit(0);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Keeper execution failed:", errorMsg);
    await sendAlert(`Critical failure in Keeper Bot: ${errorMsg}`);
    process.exit(1);
  }
}

// ── Per-recipient paginated maintenance (#586) ─────────────────────────────
//
// The old implementation called maintenance() once per recipient using the
// global MAINTENANCE_START_INDEX and MAINTENANCE_LIMIT env vars, which means
// recipients with more than MAINTENANCE_LIMIT schedules would never have their
// later indices covered.
//
// This replacement loops until a simulated maintenance() call reports nothing
// to bump (simulation error = no work), then resets the cursor back to 0 so
// the next run starts a fresh full sweep. The cursor is persisted in
// KEEPER_STATE_PATH between runs so partial progress survives restarts.
//
// Each keeper run advances one window per recipient. N runs are therefore
// needed to cover a recipient with N * MAINTENANCE_LIMIT schedule entries.
// DEPLOYMENT.md documents this N and how to tune MAINTENANCE_LIMIT.

async function maintainRecipientPaginated(
  recipient: string,
  server: SorobanRpc.Server,
  contract: Contract,
  keeperKeypair: Keypair,
  state: KeeperState,
): Promise<void> {
  const startIndex = state.nextMaintenanceIndex[recipient] ?? 0;
  const limit = MAINTENANCE_LIMIT;

  console.log(
    `Maintaining recipient: ${recipient} — window [${startIndex}, ${startIndex + limit})`,
  );

  const maintenanceStatus = await maintainRecipientWindow(
    recipient,
    server,
    contract,
    keeperKeypair,
    startIndex,
    limit,
  );

  const action = determineMaintenanceState(maintenanceStatus);
  if (action === "advance") {
    state.nextMaintenanceIndex[recipient] = startIndex + limit;
    console.log(
      `  → bumped indices [${startIndex}, ${startIndex + limit}); ` +
        `next run starts at ${startIndex + limit}`,
    );
  } else if (action === "reset") {
    state.nextMaintenanceIndex[recipient] = 0;
    console.log(
      `  → no work in window [${startIndex}, ${startIndex + limit}); cursor reset to 0`,
    );
  } else {
    console.log(
      `  → tx for ${recipient} is still pending or failed; leaving cursor at ${startIndex}`,
    );
  }
}

async function fetchActiveRecipients(): Promise<string[]> {
  const rpc = new SorobanRpc.Server(RPC_URL);
  const recipients = new Set<string>();

  try {
    const limit = 100;
    let cursor: string | undefined;
    let pageCount = 0;
    const maxPages = 10; // Prevent runaway pagination

    while (pageCount < maxPages) {
      const params: any = { limit };
      if (cursor) params.cursor = cursor;

      const events = await rpc.getEvents({
        contractIds: [CONTRACT_ID!],
        ...params,
      });

      if (!events.events || events.events.length === 0) {
        await sendAlert(
          "Discovery scan returned no events; contract event pagination may have ended or failed.",
        );
        break;
      }

      for (const event of events.events) {
        if (event.type !== "contract") continue;
        const topics: unknown[] = Array.isArray((event as any).topic)
          ? (event as any).topic
          : Array.isArray(event.contractId)
            ? event.contractId
            : [];

        const eventName = decodeTopicValue(topics[0]);
        if (!eventName) {
          console.log(`Skipping event with undecodable name`);
          continue;
        }

        const recipient = parseVestingEventRecipient(eventName, topics);
        if (recipient) {
          recipients.add(recipient);
        } else {
          console.log(`Skipping unknown event type: ${eventName}`);
        }
      }

      const nextCursor = getNextPageCursor(events);
      if (!nextCursor) {
        break;
      }

      cursor = nextCursor;
      pageCount++;
    }

    const result = Array.from(recipients);
    console.log(
      `Fetched ${result.length} active recipients from contract events`,
    );
    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error("Failed to fetch active recipients:", errorMessage);
    await sendAlert(
      `Failed to fetch active recipients from the contract event log: ${errorMessage}`,
    );
    return [];
  }
}

async function maintainInstance(
  server: SorobanRpc.Server,
  contract: Contract,
  keeperKeypair: Keypair,
) {
  console.log("Checking contract instance TTL...");
  let sourceAccount = await server.getAccount(keeperKeypair.publicKey());

  const tx = new TransactionBuilder(
    new Account(sourceAccount.accountId(), sourceAccount.sequenceNumber()),
    { fee: "100000", networkPassphrase: NETWORK_PASSPHRASE },
  )
    .addOperation(contract.call("bump_instance_ttl"))
    .setTimeout(300)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    console.log("Instance TTL bump not needed or failed simulation.");
    return;
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, sim).build();
  preparedTx.sign(keeperKeypair);

  const result = await server.sendTransaction(preparedTx);
  console.log(`Instance TTL bumped: ${result.hash}`);
}

async function pollConfirmedTransaction(
  server: SorobanRpc.Server,
  hash: string,
): Promise<"SUCCESS" | "FAILED" | "PENDING"> {
  const maxAttempts = 30;
  const retryDelayMs = 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await server.getTransaction(hash);
    if (result.status === "SUCCESS") {
      return "SUCCESS";
    }
    if (result.status === "FAILED") {
      return "FAILED";
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  return "PENDING";
}

// Returns the maintenance outcome, allowing pagination state to advance only
// when the tx has actually finalized successfully.
async function maintainRecipientWindow(
  recipient: string,
  server: SorobanRpc.Server,
  contract: Contract,
  keeperKeypair: Keypair,
  startIndex: number,
  limit: number,
): Promise<"bumped" | "no-work" | "pending" | "failed"> {
  const sourceAccount = await server.getAccount(keeperKeypair.publicKey());

  const tx = new TransactionBuilder(
    new Account(sourceAccount.accountId(), sourceAccount.sequenceNumber()),
    { fee: "100000", networkPassphrase: NETWORK_PASSPHRASE },
  )
    .addOperation(
      contract.call(
        "maintenance",
        new Address(recipient).toScVal(),
        nativeToScVal(startIndex, { type: "u32" }),
        nativeToScVal(limit, { type: "u32" }),
      ),
    )
    .setTimeout(300)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    return "no-work";
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, sim).build();
  preparedTx.sign(keeperKeypair);

  const result = await server.sendTransaction(preparedTx);
  console.log(
    `  ✓ maintenance tx submitted for ${recipient} [${startIndex}, ${startIndex + limit}): ${result.hash}`,
  );

  const txStatus = await pollConfirmedTransaction(server, result.hash);
  if (txStatus === "SUCCESS") {
    return "bumped";
  }
  if (txStatus === "FAILED") {
    await sendAlert(
      `Recipient maintenance for ${recipient} failed to confirm on-chain (hash ${result.hash}).`,
    );
    return "failed";
  }

  console.log(
    `  → maintenance tx for ${recipient} is still pending; keeping cursor at ${startIndex}`,
  );
  return "pending";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => process.exit(1));
}
