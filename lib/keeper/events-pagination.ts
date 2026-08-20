/**
 * Soroban RPC getEvents pagination helpers.
 *
 * The paging token is the response `cursor` (or the last event `id`), never
 * `latestLedger`. Mixing a ledger sequence in as `cursor` skips pages and
 * can miss vesting recipients.
 *
 * @see https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents
 */

export type EventFilter = {
  type?: "contract" | "system" | "diagnostic";
  contractIds?: string[];
  topics?: string[][];
};

export type GetEventsPageRequest =
  | {
      filters: EventFilter[];
      startLedger: number;
      limit: number;
    }
  | {
      filters: EventFilter[];
      cursor: string;
      limit: number;
    };

export type RpcEventLike = {
  id?: unknown;
  pagingToken?: unknown;
  type?: unknown;
  topic?: unknown;
  contractId?: unknown;
};

export type GetEventsPage = {
  events?: RpcEventLike[];
  cursor?: unknown;
  latestLedger?: unknown;
};

/** Opaque RPC paging token for the next getEvents page. Never uses latestLedger. */
export function extractEventsCursor(page: GetEventsPage): string | undefined {
  if (typeof page.cursor === "string" && page.cursor.length > 0) {
    return page.cursor;
  }

  const last = page.events?.[page.events.length - 1];
  if (typeof last?.id === "string" && last.id.length > 0) {
    return last.id;
  }
  if (typeof last?.pagingToken === "string" && last.pagingToken.length > 0) {
    return last.pagingToken;
  }

  return undefined;
}

/**
 * First page uses startLedger (required by RPC when no cursor). Later pages
 * use only the opaque cursor and must omit startLedger.
 */
export function buildGetEventsRequest(args: {
  contractId: string;
  startLedger: number;
  cursor?: string;
  limit: number;
}): GetEventsPageRequest {
  const filters: EventFilter[] = [
    { type: "contract", contractIds: [args.contractId] },
  ];

  if (args.cursor) {
    return { filters, cursor: args.cursor, limit: args.limit };
  }

  return { filters, startLedger: args.startLedger, limit: args.limit };
}

export function startLedgerForLookback(
  latestSequence: number,
  lookbackLedgers: number,
): number {
  if (!Number.isInteger(latestSequence) || latestSequence < 1) {
    throw new Error("latest ledger sequence must be a positive integer");
  }
  if (!Number.isInteger(lookbackLedgers) || lookbackLedgers < 0) {
    throw new Error("lookback ledgers must be a non-negative integer");
  }
  return Math.max(1, latestSequence - lookbackLedgers);
}
