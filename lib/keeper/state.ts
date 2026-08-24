export interface KeeperState {
  nextMaintenanceIndex: Record<string, number>;
  lastRunAt?: string;
}

export type WindowOutcome = "success" | "no_work" | "not_confirmed";

export function emptyKeeperState(): KeeperState {
  return { nextMaintenanceIndex: {} };
}

export function parseKeeperState(raw: unknown): KeeperState {
  if (!raw || typeof raw !== "object") {
    return emptyKeeperState();
  }
  const nextMaintenanceIndex = (raw as { nextMaintenanceIndex?: unknown })
    .nextMaintenanceIndex;
  const lastRunAt = (raw as { lastRunAt?: unknown }).lastRunAt;

  if (
    !nextMaintenanceIndex ||
    typeof nextMaintenanceIndex !== "object" ||
    Array.isArray(nextMaintenanceIndex)
  ) {
    return emptyKeeperState();
  }

  const parsed: Record<string, number> = {};
  for (const [recipient, index] of Object.entries(nextMaintenanceIndex)) {
    if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
      parsed[recipient] = index;
    }
  }
  return {
    nextMaintenanceIndex: parsed,
    lastRunAt: typeof lastRunAt === "string" ? lastRunAt : undefined,
  };
}

/**
 * Advance the per-recipient window only after a confirmed successful bump.
 * Unconfirmed or failed inclusion leaves the index unchanged so the same
 * window is retried. A simulated no-op resets to 0 for a fresh sweep.
 */
export function applyWindowOutcome(
  state: KeeperState,
  recipient: string,
  startIndex: number,
  limit: number,
  outcome: WindowOutcome,
): void {
  if (outcome === "success") {
    state.nextMaintenanceIndex[recipient] = startIndex + limit;
    return;
  }
  if (outcome === "no_work") {
    state.nextMaintenanceIndex[recipient] = 0;
  }
}
