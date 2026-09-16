import type { TokenSource } from "./google-auth.ts";
import { expectJson, httpRequest } from "./http.ts";
import type { Fetcher, PoolConfig, RunnerLaunch } from "./types.ts";
import { poolResourceName } from "./types.ts";

interface JobResource {
  name?: unknown;
  etag?: unknown;
  template?: { taskCount?: unknown; template?: { maxRetries?: unknown; timeout?: unknown; containers?: unknown } };
}
interface Operation { name?: unknown; error?: unknown; response?: { name?: unknown }; metadata?: { name?: unknown } }

export interface RunnerExecution {
  name: string;
  launchId: string | null;
  terminal: boolean;
  failed: boolean;
}

/** No cancellation/deletion method: reduced demand cannot terminate a task. */
export interface RunnerExecutionClient {
  start(pool: PoolConfig, launch: RunnerLaunch, jitConfig: string): Promise<{ operation: string; execution?: string }>;
  observe(pool: PoolConfig, launch: RunnerLaunch): Promise<RunnerExecution | null>;
  find(pool: PoolConfig, ids: readonly string[]): Promise<RunnerExecution[]>;
}

export class CloudRunJobsClient implements RunnerExecutionClient {
  private readonly canonical = new Map<string, string>();
  constructor(
    private readonly tokens: TokenSource,
    private readonly fetchImpl: Fetcher = fetch,
    private readonly maxPages = 5,
  ) {}

  async start(pool: PoolConfig, launch: RunnerLaunch, jitConfig: string) {
    const name = poolResourceName(pool);
    // Validate the dedicated template immediately before submitting a run.
    let job: JobResource;
    try { job = await this.readJob(pool); }
    catch { throw new LaunchNotSubmitted("could not validate the runner job template"); }
    const task = job?.template?.template;
    if (typeof job.etag !== "string" || !job.etag || job.template?.taskCount !== 1 ||
      !task || (task.maxRetries ?? 0) !== 0 || !Array.isArray(task.containers) ||
      task.containers.length !== 1 || task.containers[0]?.name !== "runner") {
      throw new LaunchNotSubmitted("jobs backend requires a one-task, one-container runner template with zero retries and an etag");
    }
    const timeout = typeof task.timeout === "string" && /^(\d+)s$/.exec(task.timeout);
    if (!timeout || Number(timeout[1]) <= (pool.idleTimeoutSeconds ?? 120)) {
      throw new LaunchNotSubmitted("job task timeout must exceed runner idle timeout");
    }
    const body = {
      etag: job.etag,
      overrides: { taskCount: 1, containerOverrides: [{ name: "runner", env: [
        { name: "BANTO_LAUNCH_ID", value: launch.id },
        { name: "BANTO_JIT_CONFIG", value: jitConfig },
        { name: "BANTO_RUNNER_IDLE_SECONDS", value: String(pool.idleTimeoutSeconds ?? 120) },
      ] }] },
    };
    // Never retry this POST: jobs.run has no documented idempotency key.
    const operation = await this.request<Operation>(pool, `${name}:run`, "POST", body);
    if (operation?.error) throw new Error("Cloud Run Jobs operation failed; launch outcome requires reconciliation");
    const operationName = this.operationName(pool, operation.name);
    const execution = this.operationExecution(pool, operation);
    return { operation: operationName, ...(execution ? { execution } : {}) };
  }

  async observe(pool: PoolConfig, launch: RunnerLaunch): Promise<RunnerExecution | null> {
    await this.resolve(pool);
    let execution = launch.execution;
    if (!execution && launch.operation) {
      const operation = await this.request<Operation>(pool, this.operationName(pool, launch.operation), "GET");
      execution = this.operationExecution(pool, operation) ?? undefined;
    }
    if (!execution) return null;
    return this.readExecution(pool, await this.request(pool, this.executionName(pool, execution), "GET"));
  }

  async find(pool: PoolConfig, ids: readonly string[]): Promise<RunnerExecution[]> {
    await this.resolve(pool);
    const wanted = new Set(ids);
    const found = new Map<string, RunnerExecution>();
    let token = "";
    for (let page = 0; page < this.maxPages; page++) {
      const query = new URLSearchParams({ pageSize: "100", ...(token ? { pageToken: token } : {}) });
      const body = await this.request<{ executions?: unknown; nextPageToken?: unknown }>(pool, `${poolResourceName(pool)}/executions?${query}`, "GET");
      if (body.executions !== undefined && !Array.isArray(body.executions)) throw new Error("unreadable execution listing");
      for (const raw of (body.executions ?? []) as unknown[]) {
        const execution = this.readExecution(pool, raw);
        if (!execution.launchId || !wanted.has(execution.launchId)) continue;
        const previous = found.get(execution.launchId);
        if (previous && previous.name !== execution.name) throw new Error("duplicate executions for one launch reservation");
        found.set(execution.launchId, execution);
      }
      if (body.nextPageToken !== undefined && typeof body.nextPageToken !== "string") throw new Error("unreadable execution page token");
      token = body.nextPageToken ?? "";
      if (!token) break;
    }
    // Absence, even after a complete listing, never releases a reservation.
    return [...found.values()];
  }

  private readExecution(pool: PoolConfig, value: unknown): RunnerExecution {
    const raw = record(value);
    const name = this.executionName(pool, raw.name);
    if (raw.taskCount !== 1) throw new Error("execution is not a single runner task");
    const containers = record(raw.template).containers;
    if (!Array.isArray(containers) || containers.length !== 1 || containers[0]?.name !== "runner") {
      throw new Error("unreadable runner execution template");
    }
    const env = containers[0].env;
    if (env !== undefined && !Array.isArray(env)) throw new Error("unreadable runner execution environment");
    const id = ((env ?? []) as unknown[]).map(record).find((item) => item.name === "BANTO_LAUNCH_ID")?.value;
    const completion = raw.completionTime;
    if (completion !== undefined && (typeof completion !== "string" || !Number.isFinite(Date.parse(completion)))) {
      throw new Error("unreadable execution completion time");
    }
    return { name, launchId: typeof id === "string" ? id : null,
      terminal: completion !== undefined, failed: completion !== undefined && raw.succeededCount !== 1 };
  }

  private operationExecution(pool: PoolConfig, body: Operation): string | null {
    const value = body.response?.name ?? body.metadata?.name;
    return value === undefined ? null : this.executionName(pool, value);
  }

  private executionName(pool: PoolConfig, value: unknown): string {
    return this.scopedName([`${poolResourceName(pool)}/executions/`, `${this.canonical.get(poolResourceName(pool))}/executions/`], value);
  }

  private operationName(pool: PoolConfig, value: unknown): string {
    const canonicalRoot = this.canonical.get(poolResourceName(pool))?.split("/jobs/")[0];
    return this.scopedName([`projects/${pool.project}/locations/${pool.location}/operations/`, `${canonicalRoot}/operations/`], value);
  }

  private scopedName(prefixes: string[], value: unknown): string {
    if (typeof value !== "string" || !prefixes.some((prefix) => value.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length)))) {
      throw new Error("Cloud Run returned an invalid or out-of-scope resource name");
    }
    return value;
  }

  private async resolve(pool: PoolConfig) {
    if (!this.canonical.has(poolResourceName(pool))) await this.readJob(pool);
  }

  private async readJob(pool: PoolConfig) {
    if (pool.backend !== "jobs" || !pool.job) throw new LaunchNotSubmitted("expected a jobs pool");
    const job = await this.request<JobResource>(pool, poolResourceName(pool), "GET");
    const match = typeof job?.name === "string" && /^projects\/([^/]+)\/locations\/([^/]+)\/jobs\/([^/]+)$/.exec(job.name);
    // Resolve a numeric project alias only from the authenticated GET of this
    // configured job, never from a stored launch or an execution list entry.
    if (!match || (match[1] !== pool.project && !/^\d+$/.test(match[1]!)) || match[2] !== pool.location || match[3] !== pool.job) {
      throw new LaunchNotSubmitted("job response does not identify the configured resource");
    }
    this.canonical.set(poolResourceName(pool), job.name as string);
    return job;
  }

  private async request<T = unknown>(pool: PoolConfig, resource: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    const what = `Cloud Run Jobs ${method}`;
    const response = await httpRequest(this.fetchImpl, `https://${pool.location}-run.googleapis.com/v2/${resource}`, {
      method, headers: { authorization: `Bearer ${await this.tokens.token()}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, what);
    return expectJson(response, what);
  }
}

/** A locally rejected template never reached the non-idempotent run endpoint. */
export class LaunchNotSubmitted extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unreadable Cloud Run resource");
  return value as Record<string, unknown>;
}
