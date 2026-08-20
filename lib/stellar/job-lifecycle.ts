import type { JobStatus } from "./types";

const ACTIVE_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(["queued", "processing"]);

export function isActiveJobStatus(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.has(status);
}

/**
 * A batch job counts as "active" from the moment submission starts (before
 * a jobId even exists) through queued/processing, and stops being active
 * once it reaches a terminal status. UI that gates re-submission should key
 * off this, not a component-local flag that clears as soon as the initial
 * queue request resolves (#698).
 */
export function isSubmissionBlocked(params: {
  isSubmitting: boolean;
  jobId: string | null;
  jobStatus: JobStatus;
}): boolean {
  return (
    params.isSubmitting ||
    (params.jobId !== null && isActiveJobStatus(params.jobStatus))
  );
}
