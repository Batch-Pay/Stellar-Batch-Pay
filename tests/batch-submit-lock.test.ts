/**
 * Regression guard for #698.
 *
 * The "Submit Batch" button used to re-enable as soon as the initial
 * /api/batch-submit request resolved, even though the payment job kept
 * running (queued -> processing) in the background. That let a user tweak
 * the review selection and fire a second, overlapping submission with a
 * different idempotency key, producing duplicate payments.
 *
 * `isSubmissionBlocked` is the pure decision function both BatchFlowContext
 * (to guard re-entrant onSubmit calls) and BatchReview (to disable the
 * button) key off of. It stays blocked from the moment submission starts
 * until the job reaches a terminal status, regardless of anything else
 * (like review-selection edits) changing in the meantime.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  isActiveJobStatus,
  isSubmissionBlocked,
} from "../lib/stellar/job-lifecycle";
import type { JobStatus } from "../lib/stellar/types";

describe("isActiveJobStatus", () => {
  test("queued and processing are active", () => {
    expect(isActiveJobStatus("queued")).toBe(true);
    expect(isActiveJobStatus("processing")).toBe(true);
  });

  test("completed and failed are terminal, not active", () => {
    expect(isActiveJobStatus("completed")).toBe(false);
    expect(isActiveJobStatus("failed")).toBe(false);
  });
});

describe("isSubmissionBlocked", () => {
  test("allows submission from a fresh, never-submitted state", () => {
    expect(
      isSubmissionBlocked({ isSubmitting: false, jobId: null, jobStatus: "queued" }),
    ).toBe(false);
  });

  test("blocks a second submit while the initial request is still in flight (no jobId yet)", () => {
    expect(
      isSubmissionBlocked({ isSubmitting: true, jobId: null, jobStatus: "queued" }),
    ).toBe(true);
  });

  test("stays blocked while the job is queued", () => {
    expect(
      isSubmissionBlocked({ isSubmitting: true, jobId: "job-1", jobStatus: "queued" }),
    ).toBe(true);
  });

  test("stays blocked while the job is processing", () => {
    expect(
      isSubmissionBlocked({ isSubmitting: true, jobId: "job-1", jobStatus: "processing" }),
    ).toBe(true);
  });

  test("a completed job re-enables submission", () => {
    expect(
      isSubmissionBlocked({ isSubmitting: false, jobId: "job-1", jobStatus: "completed" }),
    ).toBe(false);
  });

  test("a failed job re-enables submission", () => {
    expect(
      isSubmissionBlocked({ isSubmitting: false, jobId: "job-1", jobStatus: "failed" }),
    ).toBe(false);
  });

  test("stays blocked across every active status even if isSubmitting has already flipped false", () => {
    // Guards against relying on isSubmitting alone: once a jobId exists, an
    // active jobStatus alone must be enough to keep submission locked.
    const activeStatuses: JobStatus[] = ["queued", "processing"];
    for (const jobStatus of activeStatuses) {
      expect(
        isSubmissionBlocked({ isSubmitting: false, jobId: "job-1", jobStatus }),
      ).toBe(true);
    }
  });
});

describe("BatchReview source (#698)", () => {
  const SOURCE = readFileSync(
    path.join(process.cwd(), "components", "dashboard", "BatchReview.tsx"),
    "utf8",
  );

  test("does not track submission with a component-local useState that could clear early", () => {
    // The regression was a local `const [isSubmitting, setIsSubmitting] =
    // useState(false)` that cleared as soon as the initial fetch resolved,
    // out of sync with the background job. Pin that it's gone.
    expect(SOURCE).not.toMatch(/useState\(false\)/);
    expect(SOURCE).not.toMatch(/setIsSubmitting/);
  });

  test("derives the submit lock from the context's job lifecycle", () => {
    expect(SOURCE).toMatch(/context\.hasActiveJob/);
  });

  test("guards handleSubmit against a second call while already blocked", () => {
    const handleSubmitMatch = SOURCE.match(
      /const handleSubmit = async \(\) => \{[\s\S]*?\n {2}\};/,
    );
    expect(handleSubmitMatch).not.toBeNull();
    expect(handleSubmitMatch![0]).toMatch(/if \(!publicKey \|\| isSubmitting\)/);
  });
});

describe("BatchFlowContext source (#698)", () => {
  const SOURCE = readFileSync(
    path.join(process.cwd(), "contexts", "BatchFlowContext.tsx"),
    "utf8",
  );

  test("onSubmit guards against overlapping submissions before queuing a new job", () => {
    const onSubmitMatch = SOURCE.match(
      /const onSubmit = useCallback\(async[\s\S]*?\n {2}\}, \[[^\]]*\]\);/,
    );
    expect(onSubmitMatch).not.toBeNull();
    expect(onSubmitMatch![0]).toMatch(/isSubmissionBlocked\(/);
  });

  test("exposes hasActiveJob computed from isSubmissionBlocked", () => {
    expect(SOURCE).toMatch(/hasActiveJob = useMemo/);
  });
});
