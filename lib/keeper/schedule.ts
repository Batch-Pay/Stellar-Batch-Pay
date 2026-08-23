import { Address, rpc, xdr } from "stellar-sdk";
import {
  prioritizeRecipients,
  shouldBumpForTtl,
  type TtlSnapshot,
} from "./threshold";

export type ContractDataReader = {
  getContractData: (
    contractId: string,
    key: xdr.ScVal,
    durability?: rpc.Durability,
  ) => Promise<{ liveUntilLedgerSeq?: number }>;
};

/** Persistent storage key for DataKey::VestingCount(Address). */
export function vestingCountStorageKey(recipient: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("VestingCount"),
    new Address(recipient).toScVal(),
  ]);
}

export async function loadRecipientTtlSnapshots(
  server: ContractDataReader,
  contractId: string,
  recipients: string[],
): Promise<TtlSnapshot[]> {
  const snapshots: TtlSnapshot[] = [];

  for (const recipient of recipients) {
    let liveUntilLedger: number | null = null;
    try {
      const entry = await server.getContractData(
        contractId,
        vestingCountStorageKey(recipient),
        rpc.Durability.Persistent,
      );
      if (
        typeof entry.liveUntilLedgerSeq === "number" &&
        Number.isFinite(entry.liveUntilLedgerSeq)
      ) {
        liveUntilLedger = entry.liveUntilLedgerSeq;
      }
    } catch {
      liveUntilLedger = null;
    }
    snapshots.push({ recipient, liveUntilLedger });
  }

  return snapshots;
}

/**
 * Recipients whose VestingCount TTL is inside the bump window, soonest expiry
 * first. Unknown TTL is treated as most urgent.
 */
export function selectUrgentRecipients(
  snapshots: TtlSnapshot[],
  currentLedger: number,
  thresholdLedgers: number,
): string[] {
  const inWindow = snapshots.filter((snapshot) =>
    shouldBumpForTtl({
      liveUntilLedger: snapshot.liveUntilLedger,
      currentLedger,
      thresholdLedgers,
    }),
  );

  return prioritizeRecipients(inWindow, currentLedger, thresholdLedgers).map(
    (snapshot) => snapshot.recipient,
  );
}
