import type { WorkerPoolClient } from "./cloudrun.ts";
import type { ExecutionScaler } from "./executions.ts";
import { type Decision, decide, SUSTAINED_SHORTFALL_MS, trackStaffing, usableAnchor } from "./decide.ts";
import type { GitHubClient, RateLimitState } from "./github.ts";
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
  executions?: ExecutionScaler;
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

/**
 * How long a configured pool may go without matching a single job before that
 * is worth a line above DEBUG.
 *
 * There is no test that separates "these labels no longer match anything a
 * workflow asks for" from "this pool is genuinely quiet right now" — a
 * nightly-only pool can go a full day without demand and be exactly as healthy
 * as one whose selector drifted from every runner_labels it was meant to
 * cover. A day is chosen to sit comfortably above ordinary quiet, not because
 * it is known to separate the two cases; picking it only trades detection
 * latency against how often this fires on a pool that is working exactly as
 * configured. That is why it lands at WARNING and not ERROR: banto cannot
 * confirm the failure, only report the absence.
 */
export const POOL_NO_MATCH_WARNING_MS = 24 * 60 * 60 * 1000;

/**
 * Remaining-budget fractions that promote the once-per-reconcile budget
 * report above routine detail. Mirrors the staffing alarm's shape: ordinary
 * is quiet, tight is worth a look, and empty enough to plausibly hit zero
 * before the hourly window resets is the same practical failure as a staffing
 * outage — no pool can be scaled up — so it gets the same ERROR tier.
 */
export const BUDGET_WARNING_REMAINING_FRACTION = 0.2;
export const BUDGET_ERROR_REMAINING_FRACTION = 0.05;

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
  /** Failed writes may leave a valid but obsolete anchor in durable storage. */
  private readonly needsCooldownReset = new Set<string>();
  /**
   * The last time each pool's own pass saw *any* job attributed to it, kept in
   * memory rather than in `PoolState`. It only ever widens a WARNING window
   * by however long a restart has been up, never a scaling decision — unlike
   * `lastBusyAt`, nothing here is read by `decide()` — so losing it costs a
   * delayed report, not a wrong count. That is not worth a third stored value
   * and the schema change that would come with it.
   */
  private readonly lastMatchedAt = new Map<string, number>();
  /** Per-signature counts of jobs no configured pool claimed, since the last report. */
  private readonly unmatchedJobLabelCounts = new Map<string, number>();
  /** What `reportBudget` last printed, so it can report a delta rather than a bare snapshot. */
  private lastReportedRateLimit: RateLimitState | null = null;

  constructor(private readonly deps: ControllerDeps) {
    this.minPassIntervalMs = deps.minPassIntervalMs ?? DEFAULT_MIN_PASS_INTERVAL_MS;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // Unknown history reads as "matched just now": a fresh process should not
    // spend its first day's worth of passes accusing every pool of drift.
    for (const pool of deps.pools) {
      this.lastMatchedAt.set(pool.name, deps.clock.now());
      // A previous process may have observed work without managing to save it.
      // Establish a new anchor on the first successfully recorded observation.
      this.needsCooldownReset.add(pool.name);
    }
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
      // Left at DEBUG per event on purpose: most installations see this for
      // every GitHub-hosted job (`ubuntu-latest` and friends) alongside any
      // real drift, and there is no way to tell the two apart from one event.
      // `reportUnmatchedJobs` is where a *pattern* becomes visible instead.
      this.deps.logger.debug("no pool matches job labels", { labels });
      this.recordUnmatchedJob(labels);
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
    // Both of these summarise across every pool's passes above, so they are
    // reported once per sweep rather than once per pool — see each method's
    // own comment for why reporting them from inside a single pool's pass
    // would multiply the same installation-wide fact by the pool count.
    this.reportBudget();
    this.reportUnmatchedJobs();
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
    try {
      return await this.observeAndApply(pool);
    } catch (error) {
      // Keep the reset pending until storage recovers. This also covers an
      // ambiguous PATCH failure: elapsed time alone cannot prove it was idle.
      this.needsCooldownReset.add(pool.name);
      throw error;
    }
  }

  private async observeAndApply(pool: PoolConfig): Promise<Decision> {
    await this.respectPassInterval(pool.name);
    this.lastPassAt.set(pool.name, this.deps.clock.now());

    let evidence = await this.gatherEvidence(pool);
    if (pool.backend === "jobs") {
      if (!this.deps.executions) throw new Error("jobs backend is not configured");
      this.reportPoolMatch(pool, evidence, this.deps.clock.now());
      return this.deps.executions.reconcile(pool, evidence);
    }
    let observation = await this.recordObservation(pool, evidence);
    let decision = decide(pool, evidence, observation.state, observation.instanceCount, observation.at);
    if (decision.outcome === "scale_down") {
      // Re-fetch after the first state write: work can arrive while storage or
      // Cloud Run reads are in flight. This narrows, but cannot close, the gap
      // between the final GitHub observation and the Cloud Run PATCH.
      evidence = await this.gatherEvidence(pool);
      observation = await this.recordObservation(pool, evidence);
      decision = decide(pool, evidence, observation.state, observation.instanceCount, observation.at);
    }
    if (decision.write) {
      await this.deps.workerPools.setInstanceCount(pool, decision.target, observation.etag);
    }
    const runners = evidence.kind === "complete" ? evidence.runners : null;

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

  private async recordObservation(pool: PoolConfig, evidence: PoolEvidence) {
    const { instanceCount, etag } = await this.deps.workerPools.get(pool);
    const at = this.deps.clock.now();

    const runners = evidence.kind === "complete" ? evidence.runners : null;
    const staffing = trackStaffing((await this.deps.store.get(pool.name)).state, instanceCount, runners, at);
    this.reportStaffing(pool, instanceCount, runners, staffing);
    this.reportPoolMatch(pool, evidence, at);

    // Recorded *before* the scaling write, and a failure here fails the pass.
    // The alternative — write first, record after — loses the record of a busy
    // pool exactly when the store is unhappy, and a lost `lastBusyAt` is a
    // cooldown that never starts.
    // Any observed work or missing evidence restarts the quiet period. Excess
    // capacity is retained while work remains, rather than treating it as idle.
    const busy =
      this.needsCooldownReset.has(pool.name) ||
      evidence.kind === "partial" || evidence.demand > 0 || (runners?.busy ?? 0) > 0;
    const state = await mutate(
      this.deps.store,
      pool.name,
      (current) => ({
        ...current,
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
    this.needsCooldownReset.delete(pool.name);

    return { instanceCount, etag, at, state };
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

    // Jobs capacity comes from execution reservations and terminal platform
    // state. Stale GitHub registrations must never count as usable capacity.
    if (pool.backend === "jobs") return { kind: "complete", demand, running, runners: null };

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

  /**
   * The other half of the runner cross-check's blind spot: a pool whose
   * selector never matches a job at all looked, from the logs, identical to a
   * healthy pool with no work — a 200 for every webhook, no error, no
   * counter. That is precisely how five pools' worth of drifted labels went
   * unnoticed until the pool list was extended (see the README).
   *
   * `evidence.demand` is recomputed from scratch every pass, so "matched
   * nothing" here means this pass, not "since forever" — the duration is
   * carried by `lastMatchedAt`, not by anything this function remembers
   * between calls.
   */
  private reportPoolMatch(pool: PoolConfig, evidence: PoolEvidence, at: number): void {
    // Partial evidence reports whatever demand it managed to count, which is
    // 0 when the listing failed outright — and 0 there means "banto could not
    // finish looking", not "there was nothing to find". Letting that advance
    // the window would blame a drifted selector for an outage, and would do it
    // during the outage, when the operator has enough to read already. The
    // anchor is moved rather than held so the window measures an unbroken run
    // of passes that actually looked; the same reasoning `decide` uses when it
    // refuses to lower a count on evidence it does not trust.
    if (evidence.kind !== "complete" || evidence.demand > 0) {
      this.lastMatchedAt.set(pool.name, at);
      return;
    }
    const last = this.lastMatchedAt.get(pool.name) ?? at;
    const idleFor = Math.max(0, at - last);
    if (idleFor < POOL_NO_MATCH_WARNING_MS) return;
    // Deliberately not distinguishing "labels drifted" from "no traffic today"
    // — see POOL_NO_MATCH_WARNING_MS. Either way, the operator now has
    // something to check that used to be indistinguishable from silence.
    this.deps.logger.warn("pool has matched no job in an extended window", {
      pool: pool.name,
      labels: pool.labels,
      idleForSeconds: Math.floor(idleFor / 1000),
    });
  }

  /** Signature a job's labels are grouped by, so repeats of the same set count as one thing. */
  private recordUnmatchedJob(labels: readonly string[]): void {
    const key = [...new Set(labels.map((l) => l.toLowerCase()))].sort().join(",");
    this.unmatchedJobLabelCounts.set(key, (this.unmatchedJobLabelCounts.get(key) ?? 0) + 1);
  }

  /**
   * Summarise, once per reconcile sweep, the deliveries `handleWorkflowJob`
   * could not attribute to any pool since the last summary.
   *
   * Only webhook deliveries feed this, not the job listings each pool's own
   * pass fetches during `reconcile`: those are already filtered per pool (see
   * `gatherEvidence`), fetched once per pool rather than once for the whole
   * installation, and not shared between pools on purpose (see "Reconcile" in
   * the README) — folding them in here would either double-count a job every
   * pool's listing happened to include, or require gathering an installation-
   * wide listing this design deliberately does not take.
   *
   * This is intentionally left at INFO regardless of volume. Most
   * installations route jobs that were never meant for a self-hosted pool
   * through the same webhook (`ubuntu-latest` and the like — see the test
   * fixture in controller.test.ts), so a high count on its own does not mean
   * anything is wrong; only a human who knows their own workflows can tell a
   * drifted pool selector from ordinary GitHub-hosted traffic. Escalating this
   * on count or persistence alone would be a warning that cries wolf on every
   * installation that runs both kinds of job, which is most of them.
   */
  private reportUnmatchedJobs(): void {
    if (this.unmatchedJobLabelCounts.size === 0) return;
    const bySignature = [...this.unmatchedJobLabelCounts.entries()]
      .map(([labels, count]) => ({ labels, count }))
      .sort((a, b) => b.count - a.count);
    const total = bySignature.reduce((sum, entry) => sum + entry.count, 0);
    this.deps.logger.info("jobs matched no configured pool since the last reconcile", {
      total,
      distinctLabelSets: bySignature.length,
      bySignature,
    });
    this.unmatchedJobLabelCounts.clear();
  }

  /**
   * Surface the installation's GitHub API budget once per reconcile sweep.
   *
   * `github.rateLimit()` reflects whichever call across *every* pool happened
   * to land last — there is exactly one `GitHubClient` for the whole process
   * (see main.ts), so the counter is already installation-wide before this
   * function ever runs. Reading it from each pool's own pass would print the
   * same shared number once per pool, which is the exact failure this exists
   * to fix: an operator having to multiply by pool count instead of banto
   * just saying the number.
   *
   * The delta is against the last time this function printed anything, not
   * against the start of this sweep: webhook-triggered passes between two
   * reconciles spend the same shared budget and belong in the same figure.
   */
  private reportBudget(): void {
    const rateLimit = this.deps.github.rateLimit();
    if (rateLimit === null || rateLimit.limit <= 0) return; // nothing observed yet
    const { remaining, limit, resetAt } = rateLimit;
    const fraction = remaining / limit;
    const previous = this.lastReportedRateLimit;
    // A delta only means "spent" within one hourly window: once resetAt moves,
    // remaining legitimately jumps back up, and reporting that as consumption
    // would read as banto regaining budget it never lost.
    const consumedSincePreviousReport =
      previous !== null && previous.resetAt === resetAt ? Math.max(0, previous.remaining - remaining) : null;
    this.lastReportedRateLimit = rateLimit;

    const fields = {
      remaining,
      limit,
      percentRemaining: Math.round(fraction * 1000) / 10,
      resetAt: new Date(resetAt).toISOString(),
      ...(consumedSincePreviousReport === null ? {} : { consumedSincePreviousReport }),
    };
    if (fraction <= BUDGET_ERROR_REMAINING_FRACTION) {
      // Same tier as the staffing alarm, because it is the same practical
      // failure: nothing can be scaled up until the window resets.
      this.deps.logger.error("GitHub API budget is nearly exhausted", fields);
    } else if (fraction <= BUDGET_WARNING_REMAINING_FRACTION) {
      this.deps.logger.warn("GitHub API budget is running low", fields);
    } else {
      this.deps.logger.debug("GitHub API budget", fields);
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
