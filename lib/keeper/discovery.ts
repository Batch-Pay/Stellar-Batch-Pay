import {
  decodeTopicValue,
  parseVestingEventRecipient,
} from "../stellar/vesting-events";
import {
  buildGetEventsRequest,
  extractEventsCursor,
  startLedgerForLookback,
  type GetEventsPage,
  type GetEventsPageRequest,
  type RpcEventLike,
} from "./events-pagination";

export type EventsRpc = {
  getLatestLedger: () => Promise<{ sequence: number }>;
  getEvents: (request: GetEventsPageRequest) => Promise<GetEventsPage>;
};

export type DiscoveryOptions = {
  rpc: EventsRpc;
  contractId: string;
  lookbackLedgers: number;
  maxPages: number;
  pageLimit: number;
  onAlert: (message: string) => Promise<void>;
};

export function recipientFromRpcEvent(event: RpcEventLike): string | undefined {
  if (event.type !== "contract") return undefined;

  const topics: unknown[] = Array.isArray(event.topic)
    ? event.topic
    : Array.isArray(event.contractId)
      ? event.contractId
      : [];

  const eventName = decodeTopicValue(topics[0]);
  if (!eventName) return undefined;

  return parseVestingEventRecipient(eventName, topics);
}

/**
 * Walk every getEvents page using the RPC paging cursor. Errors and empty
 * discovery results emit alerts; RPC failures throw so the keeper does not
 * treat a failed fetch as "no recipients".
 */
export async function fetchActiveRecipients(
  options: DiscoveryOptions,
): Promise<string[]> {
  const recipients = new Set<string>();

  try {
    const latest = await options.rpc.getLatestLedger();
    const startLedger = startLedgerForLookback(
      latest.sequence,
      options.lookbackLedgers,
    );

    let cursor: string | undefined;
    let pageCount = 0;
    let stoppedEarly = false;

    while (pageCount < options.maxPages) {
      const request = buildGetEventsRequest({
        contractId: options.contractId,
        startLedger,
        cursor,
        limit: options.pageLimit,
      });
      const page = await options.rpc.getEvents(request);
      const events = page.events ?? [];

      if (events.length === 0) {
        break;
      }

      for (const event of events) {
        const recipient = recipientFromRpcEvent(event);
        if (recipient) {
          recipients.add(recipient);
        }
      }

      pageCount += 1;
      const nextCursor = extractEventsCursor(page);
      if (!nextCursor || nextCursor === cursor) {
        break;
      }
      if (events.length < options.pageLimit) {
        break;
      }
      cursor = nextCursor;
      if (pageCount >= options.maxPages) {
        stoppedEarly = true;
        break;
      }
    }

    if (stoppedEarly) {
      await options.onAlert(
        `Recipient discovery hit max pages (${options.maxPages}) before exhausting events; some recipients may be missing.`,
      );
    }

    const result = Array.from(recipients);
    if (result.length === 0) {
      await options.onAlert(
        "Recipient discovery returned no vesting recipients. Vesting storage TTL may go unmaintained.",
      );
    }

    console.log(
      `Fetched ${result.length} active recipients from contract events (${pageCount} page(s))`,
    );
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await options.onAlert(
      `Failed to fetch active recipients from RPC events: ${errorMsg}`,
    );
    throw error;
  }
}
