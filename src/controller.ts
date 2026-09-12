import type { WorkerPoolClient } from "./cloudrun.ts";
import { type Decision, decide, SUSTAINED_SHORTFALL_MS, trackStaffing, usableAnchor } from "./decide.ts";
import type { GitHubClient } from "./github.ts";
import type { Logger } from "./log.ts";
import { selectPool } from "./match.ts";
import { type DemandStore, mutate, type MutateOptions } from "./store.ts";
import type {
  Clock,
  ObservedJob,
  ObservedRunner,
  PoolConfig,
  PoolEvidence,
  RunnerObservation,
  WorkflowJobEvent,
} from "./types.ts";

/**
 * The part that decides and acts. Everything it talks to is injected, so the
 * tests exercise the real control flow with fakes and never open a socket.
 *
 * **A pass computes; it does not remember, and it is not handed anything.**
 * `runPass` takes a pool and nothing else. It claims the pool's slot, waits out
 * the interval floor, and only then asks GitHub what is queued, asks GitHub
 * which runners are busy, and asks Cloud Run what the instance count is. Every
 * observation it acts on was taken after it began.
 *
 * That signature is the point. Earlier versions passed observations in — a
 * reconcile gathering listings before entering the per-pool queue, a queued
 * pass closing over the evidence its trigger had — and each time, evidence
 * gathered at one moment was used at another after an arbitrary delay: a stale
 * "idle" reading would scale a pool that had become busy in between. Moving the
 * code did not remove the hazard; removing the parameter does, because there is
 * no longer a way to express it.
 *
 * **Triggers carry intent, never data.** A `workflow_job` delivery means "look
 * at this pool again"; its payload chooses the pool and is discarded. Joining a
 * pass that has not looked at anything yet is therefore always safe, which is
 * what makes coalescing sound.
 *
 * **banto runs as a single instance** (see the README): with one process,
 * serialising per pool here is the whole of the mutual exclusion it needs.
 */

export interface ControllerDeps {
  pools: PoolConfig[];
  store: DemandStore;
  workerPools: WorkerPoolClient;
  github: GitHubClient;
  clock: Clock;
  logger: Logger;
  /**
   * Floor on the interval between passes for one pool. Every pass costs GitHub
   * API calls, and the installation's rate limit is the budget being spent;
   * this is what bounds the spend under a burst. It is applied before any
   * observation is fetched, so a queue of triggers cannot multiply listings.
   */
  minPassIntervalMs?: number;
  /** Injected so tests do not wait out the interval. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Retry behaviour for state writes. Exposed so a test can make the backoff
   * deterministic: left alone it uses real timers and `Math.random`, which is
   * right in production and makes a property test's interleavings
   * irreproducible.
   */
  retry?: MutateOptions;
}

export type EventOutcome =
  | { handled: false; reason: "ignored_action" | "no_matching_pool" }
  | { handled: true; pool: string; decision: Decision };

export interface ReconcileResult {
  decisions: Decision[];
  /** Pools whose pass failed; the caller turns this into a non-2xx. */
  failures: { pool: string; error: string }[];
  /** False when any pool's pass ran on evidence that might be partial. */
  evidenceComplete: boolean;
}

/** Actions that mean something changed for a pool. Anything else is noise. */
const TRIGGERING_ACTIONS = new Set(["queued", "in_progress", "completed"]);
const DEFAULT_MIN_PASS_INTERVAL_MS = 10_000;

interface PoolRuns {
  /** The pass currently running. */
  current: Promise<Decision>;
  /** The single pass queued behind it; further triggers join this one. */
  queued?: Promise<Decision>;
}

export class Controller {
  private readonly minPassIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly runs = new Map<string, PoolRuns>();
  private readonly lastPassAt = new Map<string, number>();

  constructor(private readonly deps: ControllerDeps) {
    this.minPassIntervalMs = deps.minPassIntervalMs ?? DEFAULT_MIN_PASS_INTERVAL_MS;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async handleWorkflowJob(event: WorkflowJobEvent): Promise<EventOutcome> {
    if (!TRIGGERING_ACTIONS.has(event.action)) {
      // `waiting`, `requested` and anything GitHub adds later: a job in those
      // states has not been offered to a runner, so nothing has changed yet.
      this.deps.logger.debug("ignoring workflow_job action", { action: event.action });
      return { handled: false, reason: "ignored_action" };
    }

    const labels = event.workflow_job?.labels ?? [];
    const pool = selectPool(this.deps.pools, labels);
    if (!pool) {
      this.deps.logger.debug("no pool matches job labels", { labels });
      return { handled: false, reason: "no_matching_pool" };
    }

    const decision = await this.trigger(pool);
    return { handled: true, pool: pool.name, decision };
  }

  /**
   * Run a pass for every pool.
   *
   * This is the scheduled backstop, and it is deliberately nothing more than a
   * trigger for each pool: it gathers no listings of its own, because anything
   * it gathered would age while the pools queued behind one another. Each pool's
   * pass fetches what it needs when it runs.
   */
  async reconcile(): Promise<ReconcileResult> {
    const decisions: Decision[] = [];
    const failures: { pool: string; error: string }[] = [];
    let evidenceComplete = true;
    for (const pool of this.deps.pools) {
      try {
        const decision = await this.trigger(pool);
        decisions.push(decision);
        if (!decision.evidenceComplete) evidenceComplete = false;
      } catch (error) {
        // One unreachable pool must not stop the others from being corrected —
        // but the caller is told, so Cloud Scheduler can retry.
        const message = errorMessage(error);
        failures.push({ pool: pool.name, error: message });
        this.deps.logger.error("pass failed for pool", { pool: pool.name, error: message });
      }
    }
    return { decisions, failures, evidenceComplete };
  }

  /**
   * Run a pass for a pool, coalescing with any pass already in flight.
   *
   * A trigger that arrives while a pass is running joins the single queued
   * follow-up. That is safe precisely because a pass carries no evidence: the
   * queued pass has not looked at anything yet, so whatever the joining trigger
   * is about will be visible to it.
   */
  private trigger(pool: PoolConfig): Promise<Decision> {
    const key = pool.name;
    const entry = this.runs.get(key);

    if (!entry) {
      const current = this.runPass(pool);
      this.runs.set(key, { current });
      void current.catch(() => {}).then(() => this.clearIfCurrent(key, current));
      return current;
    }

    if (entry.queued) return entry.queued;

    const queued: Promise<Decision> = entry.current
      .catch(() => undefined)
      .then(() => {
        // It is starting now, so it becomes the pass others queue behind.
        this.runs.set(key, { current: queued });
        return this.runPass(pool);
      });
    entry.queued = queued;
    void queued.catch(() => {}).then(() => this.clearIfCurrent(key, queued));
    return queued;
  }

  private clearIfCurrent(key: string, pass: Promise<Decision>): void {
    const entry = this.runs.get(key);
    if (entry && entry.current === pass && !entry.queued) this.runs.delete(key);
  }

  /**
   * One pass: wait for the slot, then look at the world, then act on it.
   *
   * Note what this function does not take. Every observation below is fetched
   * after the interval floor has elapsed and after any earlier pass has
   * finished, so nothing it decides on can have been gathered before the
   * trigger that asked for it.
   */
  private async runPass(pool: PoolConfig): Promise<Decision> {
    await this.respectPassInterval(pool.name);
    this.lastPassAt.set(pool.name, this.deps.clock.now());

    const evidence = await this.gatherEvidence(pool);
    const { instanceCount, etag } = await this.deps.workerPools.get(pool);
    const at = this.deps.clock.now();

    const runners = evidence.kind === "complete" ? evidence.runners : null;
    const staffing = trackStaffing((await this.deps.store.get(pool.name)).state, instanceCount, runners, at);
    this.reportStaffing(pool, instanceCount, runners, staffing);

    // Recorded *before* the scaling write, and a failure here fails the pass.
    // The alternative — write first, record after — loses the record of a busy
    // pool exactly when the store is unhappy, and a lost `lastBusyAt` is a
    // cooldown that never starts.
    // "Busy" means *every instance was justified*: demand at least matched the
    // count, or a runner was working. Refreshing the anchor whenever there was
    // any demand at all was wrong in a way only an interleaving test found — a
    // pool with steady demand of 3 and 4 instances refreshed its own anchor on
    // every pass and could never shed the fourth.
    const busy = (evidence.demand > 0 && evidence.demand >= instanceCount) || (runners?.busy ?? 0) > 0;
    const state = await mutate(
      this.deps.store,
      pool.name,
      (current) => ({
        // First pass for a pool seeds the anchor with now: an unknown history
        // is treated as "busy just now", so a pool is never scaled away on the
        // strength of having no record. An anchor that cannot be used — absurd,
        // or in the future because a clock stepped — is *repaired* the same
        // way, so a bad value costs one cooldown instead of standing forever.
        lastBusyAt: busy ? at : (usableAnchor(current.lastBusyAt, at) ?? at),
        shortfallSince:
          runners === null ? (current.shortfallSince ?? null) : (staffing.state.shortfallSince ?? null),
      }),
      this.deps.retry ?? {},
    );

    const decision = decide(pool, evidence, state, instanceCount, at);
    if (decision.write) {
      await this.deps.workerPools.setInstanceCount(pool, decision.target, etag);
    }

    this.deps.logger.info("scaling decision", {
      pool: decision.pool,
      demand: decision.demand,
      warmSpare: pool.warmSpare,
      current: decision.current,
      desired: decision.desired,
      target: decision.target,
      outcome: decision.outcome,
      wrote: decision.write,
      evidence: evidence.kind,
      ...(evidence.kind === "partial" ? { evidenceReason: evidence.reason } : { running: evidence.running }),
      ...(runners === null ? {} : { runnersOnline: runners.online, runnersBusy: runners.busy }),
      ...(decision.idleEvidence === undefined ? {} : { idleEvidence: decision.idleEvidence }),
      ...(decision.cooldownRemainingSeconds === undefined
        ? {}
        : { cooldownRemainingSeconds: decision.cooldownRemainingSeconds }),
    });
    return decision;
  }

  /**
   * Turn two API listings into evidence about one pool.
   *
   * Anything that could hide demand or hide a busy runner produces the partial
   * variant, which the type system then keeps away from every lowering
   * decision. The one case that is *not* missing evidence is a cross-check that
   * was never configured: no `runnerRepo` on this pool and no `GITHUB_ORG` for
   * the deployment is a deployment choice, not a gap.
   */
  private async gatherEvidence(pool: PoolConfig): Promise<PoolEvidence> {
    let jobs: ObservedJob[] = [];
    let jobsComplete = true;
    let reason = "";
    try {
      const listing = await this.deps.github.observeJobs();
      jobs = listing.items;
      jobsComplete = listing.complete;
      if (!jobsComplete) reason = "job listing incomplete";
    } catch (error) {
      jobsComplete = false;
      reason = "job listing unavailable";
      this.deps.logger.warn("job listing unavailable; this pass cannot lower any count", {
        pool: pool.name,
        error: errorMessage(error),
      });
    }

    let demand = 0;
    let running = 0;
    for (const job of jobs) {
      if (selectPool(this.deps.pools, job.labels)?.name !== pool.name) continue;
      demand++;
      if (job.status === "in_progress") running++;
    }

    if (!jobsComplete) return { kind: "partial", demand, reason };

    let runners: RunnerObservation | null = null;
    try {
      // A pool that registers its runners to a repository rather than the org
      // (see `runnerRepo` on `PoolConfig`) is asked there instead. Not shared
      // across pools even when several declare the same repo: the design
      // choice not to hand one listing to a queued pool (see "Reconcile" in
      // the README) applies here for the same reason it applies to jobs — a
      // listing gathered for one pool would age while the next one waited.
      const listing = await this.deps.github.observeRunners(pool.runnerRepo);
      if (!listing.configured) {
        // Deliberately not a gap: neither this pool nor the deployment names a
        // scope to ask.
        runners = null;
      } else if (!listing.complete) {
        return { kind: "partial", demand, reason: "runner listing incomplete" };
      } else {
        runners = runnersFor(this.deps.pools, pool, listing.items);
      }
    } catch (error) {
      // A configured cross-check that failed is missing evidence, and missing
      // evidence must not fall through to the cooldown: the runner it could not
      // read might be the busy one.
      this.deps.logger.warn("runner cross-check failed; this pass cannot lower any count", {
        pool: pool.name,
        error: errorMessage(error),
      });
      return { kind: "partial", demand, reason: "runner listing unavailable" };
    }

    return { kind: "complete", demand, running, runners };
  }

  /**
   * Space passes out. Each one spends part of the installation's API budget, so
   * a burst of triggers must not turn into a burst of listings. This runs before
   * any observation is fetched, which is the only placement that actually
   * bounds the spend.
   */
  private async respectPassInterval(pool: string): Promise<void> {
    const last = this.lastPassAt.get(pool);
    if (last === undefined) return;
    const wait = this.minPassIntervalMs - (this.deps.clock.now() - last);
    if (wait > 0) await this.sleep(wait);
  }

  private reportStaffing(
    pool: PoolConfig,
    instanceCount: number,
    runners: RunnerObservation | null,
    staffing: { shortfall: number; sustainedFor: number | null },
  ): void {
    if (runners === null) return;
    const fields = {
      pool: pool.name,
      instances: instanceCount,
      runnersRegistered: runners.registered,
      runnersOnline: runners.online,
      runnersBusy: runners.busy,
      shortfall: staffing.shortfall,
    };
    if (staffing.shortfall === 0) {
      this.deps.logger.debug("pool staffing healthy", fields);
      return;
    }
    if ((staffing.sustainedFor ?? 0) >= SUSTAINED_SHORTFALL_MS) {
      // The failure this makes visible: banto raises the instance count, the
      // instances start, and none of them registers as a runner (a bad App key,
      // an image that cannot pull, a crash loop). Demand stays queued forever
      // and, without this line, nothing in the logs says why.
      this.deps.logger.error("worker pool instances are not becoming runners", {
        ...fields,
        sustainedForSeconds: Math.floor((staffing.sustainedFor ?? 0) / 1000),
      });
    } else {
      this.deps.logger.info("pool instances not yet registered as runners", fields);
    }
  }
}

/** Runners are matched to pools by the same selector logic as jobs. */
export function runnersFor(
  pools: readonly PoolConfig[],
  pool: PoolConfig,
  runners: readonly ObservedRunner[],
): RunnerObservation {
  const observation: RunnerObservation = { registered: 0, online: 0, busy: 0 };
  for (const runner of runners) {
    if (selectPool(pools, runner.labels)?.name !== pool.name) continue;
    observation.registered++;
    if (runner.status === "online") observation.online++;
    if (runner.busy) observation.busy++;
  }
  return observation;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
