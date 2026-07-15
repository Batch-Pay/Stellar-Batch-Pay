import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseVestingClaimedPayload,
  parseVestingDeposited,
  parseVestingRevoked,
  parseVestingTransferred,
  parseVestingEventRecipient,
} from "../lib/stellar/vesting-events";

const SNAPSHOT_DIR = join(
  __dirname,
  "../contracts/batch-vesting/test_snapshots/test",
);

function loadSnapshot(name: string) {
  const raw = readFileSync(join(SNAPSHOT_DIR, name), "utf-8");
  return JSON.parse(raw) as {
    events: Array<{
      event: {
        body: {
          v0: {
            topics: unknown[];
            data: unknown;
          };
        };
      };
    }>;
  };
}

function findEventData(snapshotName: string, symbol: string): unknown {
  const snapshot = loadSnapshot(snapshotName);
  const match = snapshot.events.find((entry) => {
    const topic = entry.event.body.v0.topics[0] as { symbol?: string };
    return topic?.symbol === symbol;
  });
  if (!match) {
    throw new Error(`Event ${symbol} not found in ${snapshotName}`);
  }
  return match.event.body.v0.data;
}

describe("parseVestingClaimedPayload", () => {
  test("parses amount, token, and memo from event payload", () => {
    const parsed = parseVestingClaimedPayload(["100", "CDTOKENADDRESS", "Q1 payroll"]);
    expect(parsed).toEqual({
      amount: "100",
      token: "CDTOKENADDRESS",
      memo: "Q1 payroll",
    });
  });

  test("requires token address for claim payloads", () => {
    expect(() => parseVestingClaimedPayload(["100"])).toThrow(
      "Invalid VestingClaimed payload format.",
    );
  });
});

describe("vesting event parsers from contract snapshots", () => {
  test("parseVestingDeposited decodes deposit fixture", () => {
    const data = findEventData(
      "test_deposit_event_includes_token_address.1.json",
      "VestingDeposited",
    );
    const parsed = parseVestingDeposited(data);
    expect(parsed.amount).toBe("100");
    expect(parsed.endTime).toBe(1000);
    expect(parsed.token).toBe(
      "CDS3FDGQ4JA2V3F26Y4BMWWJEC5TT26RJBN7KIQKUMVO2MAOCMDTSZ7A",
    );
    expect(parsed.memo).toBe("");
  });

  test("parseVestingRevoked decodes revoke fixture", () => {
    const data = findEventData(
      "test_revoke_event_includes_token_address.1.json",
      "VestingRevoked",
    );
    const parsed = parseVestingRevoked(data);
    expect(parsed.revokedAmount).toBe("100");
    expect(parsed.pendingVested).toBe("0");
    expect(parsed.token).toBe(
      "CDS3FDGQ4JA2V3F26Y4BMWWJEC5TT26RJBN7KIQKUMVO2MAOCMDTSZ7A",
    );
  });

  test("parseVestingClaimed decodes claim fixture", () => {
    const data = findEventData(
      "test_claim_event_includes_token_address.1.json",
      "VestingClaimed",
    );
    const parsed = parseVestingClaimedPayload(data);
    expect(parsed.amount).toBeTruthy();
    expect(parsed.token).toBeTruthy();
  });

  test("parseVestingEventRecipient reads recipient topic", () => {
    const snapshot = loadSnapshot("test_deposit_event_includes_token_address.1.json");
    const entry = snapshot.events.find((e) => {
      const topic = e.event.body.v0.topics[0] as { symbol?: string };
      return topic?.symbol === "VestingDeposited";
    });
    const topics = entry!.event.body.v0.topics;
    expect(parseVestingEventRecipient("VestingDeposited", topics)).toBe(
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM",
    );
  });
});

describe("parseVestingTransferred", () => {
  test("parses new address and old index from tuple payload", () => {
    const parsed = parseVestingTransferred([
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
      3,
    ]);
    expect(parsed).toEqual({
      newAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
      oldIndex: 3,
    });
  });
});
