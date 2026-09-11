import type { WorkerPoolClient, WorkerPoolState } from "../src/cloudrun.ts";
import type { GitHubClient, Listing, RateLimitState, RunnerListing } from "../src/github.ts";
import { createLogger, type Logger } from "../src/log.ts";
import type { Clock, ObservedJob, ObservedRunner, PoolConfig } from "../src/types.ts";

/** A clock the test drives by hand. */
export class FakeClock implements Clock {
  constructor(private current = 1_700_000_000_000) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): this {
    this.current += ms;
    return this;
  }
  set(ms: number): this {
    this.current = ms;
    return this;
  }
}

/** Cloud Run stand-in: remembers instance counts and every write it was asked for. */
export class FakeWorkerPools implements WorkerPoolClient {
  readonly writes: { pool: string; count: number }[] = [];
  private readonly counts = new Map<string, number>();
  failNextWrite: Error | null = null;
  failNextGet: Error | null = null;
  /** Hooks for committing state mid-pass, to exercise the apply loop. */
  beforeWrite: (() => Promise<void>) | null = null;
  beforeGet: (() => Promise<void>) | null = null;

  constructor(initial: Record<string, number> = {}) {
    for (const [pool, count] of Object.entries(initial)) this.counts.set(pool, count);
  }

  async get(pool: PoolConfig): Promise<WorkerPoolState> {
    if (this.beforeGet) await this.beforeGet();
    if (this.failNextGet) {
      const error = this.failNextGet;
      this.failNextGet = null;
      throw error;
    }
    return { instanceCount: this.counts.get(pool.name) ?? 0, etag: `etag-${pool.name}` };
  }

  async setInstanceCount(pool: PoolConfig, count: number, _etag: string): Promise<void> {
    if (this.beforeWrite) await this.beforeWrite();
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }
    this.counts.set(pool.name, count);
    this.writes.push({ pool: pool.name, count });
  }

  countOf(pool: string): number {
    return this.counts.get(pool) ?? 0;
  }
}

export class FakeGitHub implements GitHubClient {
  calls = 0;
  runnerCalls = 0;
  /** null stands for "the runner list was not available". */
  runners: ObservedRunner[] | null = null;
  runnerError: Error | null = null;
  jobsComplete = true;
  runnersComplete = true;

  constructor(
    public jobs: ObservedJob[] = [],
    runners: ObservedRunner[] | null = null,
  ) {
    this.runners = runners;
  }

  /** Hook for gating or failing a listing, to exercise the pass loop. */
  beforeObserve: (() => Promise<void>) | null = null;

  async observeJobs(): Promise<Listing<ObservedJob>> {
    this.calls++;
    if (this.beforeObserve) await this.beforeObserve();
    return { items: this.jobs, complete: this.jobsComplete };
  }

  async observeRunners(): Promise<RunnerListing> {
    this.runnerCalls++;
    if (this.runnerError) throw this.runnerError;
    // null stands for "no GITHUB_ORG configured", which is not a gap.
    if (this.runners === null) return { configured: false };
    return { configured: true, items: this.runners, complete: this.runnersComplete };
  }

  rateLimit(): RateLimitState | null {
    return null;
  }
}

export function runner(overrides: Partial<ObservedRunner> = {}): ObservedRunner {
  return {
    id: 1,
    name: "gh-runner-default-abcd",
    busy: false,
    status: "online",
    labels: ["self-hosted", "runner-default"],
    ...overrides,
  };
}

export function pool(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    name: "default",
    project: "test-project",
    location: "asia-northeast1",
    workerPool: "test-runner",
    labels: ["self-hosted", "runner-default"],
    min: 0,
    max: 5,
    warmSpare: 0,
    cooldownSeconds: 300,
    ...overrides,
  };
}

/** A logger that keeps every line, so tests can assert on what was reported. */
export function collectLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger("DEBUG", (line) => lines.push(JSON.parse(line)));
  return { logger, lines };
}

/** Job fixtures: `n` jobs with one label set, queued unless told otherwise. */
export function jobsFor(
  ids: number[],
  labels: string[],
  status: "queued" | "in_progress" = "queued",
): ObservedJob[] {
  return ids.map((id) => ({ id, status, labels }));
}
