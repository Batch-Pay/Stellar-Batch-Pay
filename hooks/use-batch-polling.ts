import { useState, useEffect, useRef } from "react";
import type { JobStatus, BatchResult } from "@/lib/stellar/types";
import { authenticatedFetch } from "@/lib/wallet-session-client";

export interface JobState {
  status: JobStatus;
  totalBatches: number;
  completedBatches: number;
  totalPayments: number;
  result?: BatchResult;
  error?: string;
}

const BASE_POLL_INTERVAL = 2000;
const MAX_POLL_INTERVAL = 30000;

function isTerminal(status: JobStatus) {
  return status === "completed" || status === "failed";
}

// SSE-based live updates with automatic polling fallback.
// Requires an authenticated wallet session (HttpOnly cookie + bearer token)
// before connecting; pass sessionReady=true once ensureSession() resolves.
export function useBatchPolling(
  jobId: string | null,
  publicKey: string | null,
  sessionReady = false,
) {
  const [jobState, setJobState] = useState<JobState | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!jobId || !publicKey || !sessionReady) {
      setJobState(null);
      setIsPolling(false);
      return;
    }

    setIsPolling(true);
    let active = true;

    // Try SSE first. EventSource sends same-origin cookies set by /api/auth/verify.
    if (typeof EventSource !== "undefined") {
      const params = new URLSearchParams({ publicKey });
      const es = new EventSource(`/api/batch-events/${jobId}?${params.toString()}`);
      let sseEstablished = false;

      es.onopen = () => {
        sseEstablished = true;
      };

      es.onmessage = (event) => {
        if (!active) return;
        try {
          const data = JSON.parse(event.data) as JobState & { error?: string };
          if (data.error) {
            es.close();
            setIsPolling(false);
            return;
          }
          setJobState(data);
          if (isTerminal(data.status)) {
            es.close();
            setIsPolling(false);
          }
        } catch {
          // ignore malformed frames
        }
      };

      es.onerror = () => {
        es.close();
        if (!active) return;

        if (!sseEstablished) {
          startPolling();
        } else {
          setIsPolling(false);
        }
      };

      cleanupRef.current = () => {
        es.close();
      };

      return () => {
        active = false;
        es.close();
        cleanupRef.current = null;
      };
    }

    startPolling();
    return () => {
      active = false;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };

    function startPolling() {
      let retryCount = 0;
      let timeoutId: ReturnType<typeof setTimeout>;

      const poll = async () => {
        if (!active) return;
        try {
          const params = new URLSearchParams({ publicKey: publicKey! });
          const response = await authenticatedFetch(
            `/api/batch-status/${jobId}?${params.toString()}`,
            publicKey,
          );
          if (!response.ok) throw new Error("Failed to fetch job status");

          const data = (await response.json()) as JobState;
          if (!active) return;
          setJobState(data);
          retryCount = 0;

          if (isTerminal(data.status)) {
            setIsPolling(false);
            return;
          }
        } catch {
          retryCount++;
        }

        if (!active) return;
        const delay = Math.min(BASE_POLL_INTERVAL * Math.pow(2, retryCount), MAX_POLL_INTERVAL);
        timeoutId = setTimeout(poll, delay);
      };

      poll();

      cleanupRef.current = () => clearTimeout(timeoutId);
    }
  }, [jobId, publicKey, sessionReady]);

  return { jobState, isPolling };
}
