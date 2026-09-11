import type { GitHubClient, Listing, RateLimitState, RunnerListing } from "../src/github.ts";
import type { ObservedJob, ObservedRunner } from "../src/types.ts";

/** A promise a test can hold open and release at a chosen moment. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * A GitHub fake whose listings can be held open, failed, or changed mid-flight.
 *
 * `beforeJobs` and `beforeRunners` receive the call number, so a test can hold
 * exactly the first pass open while the rest of the system carries on.
 */
export class ControllableGitHub implements GitHubClient {
  jobs: ObservedJob[];
  runners: ObservedRunner[] | null = null;
  jobsComplete = true;
  runnersComplete = true;
  calls = 0;
  runnerCalls = 0;
  beforeJobs: ((call: number) => Promise<void>) | null = null;
  beforeRunners: ((call: number) => Promise<void>) | null = null;

  constructor(jobs: ObservedJob[] = []) {
    this.jobs = jobs;
  }

  async observeJobs(): Promise<Listing<ObservedJob>> {
    const call = ++this.calls;
    if (this.beforeJobs) await this.beforeJobs(call);
    // Read *after* the hook: a test that changes the world while a pass is held
    // open is asserting on what the pass sees when it finally looks.
    return { items: [...this.jobs], complete: this.jobsComplete };
  }

  async observeRunners(): Promise<RunnerListing> {
    const call = ++this.runnerCalls;
    if (this.beforeRunners) await this.beforeRunners(call);
    if (this.runners === null) return { configured: false };
    return { configured: true, items: [...this.runners], complete: this.runnersComplete };
  }

  rateLimit(): RateLimitState | null {
    return null;
  }
}
