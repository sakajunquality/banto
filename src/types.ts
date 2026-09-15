// Shared vocabulary. Everything that crosses a module boundary is defined here
// so the pure decision code never has to import a transport module.

/** A job that still wants a runner. */
export type JobStatus = "queued" | "in_progress";

/**
 * Everything banto persists, which is only what it cannot recompute.
 *
 * Demand is *not* here. It is computed from the GitHub API on every pass, and
 * the answer to "what is queued for this pool right now" is the demand. An
 * accumulated model of that — tracked job ids, tombstones, overflow counters,
 * cached runner observations — is what earlier versions kept, and every one of
 * them needed a merge rule for partial or out-of-order observations. The merge
 * rules were the bugs. There is nothing to merge into any more.
 *
 * What is left cannot be derived from a single listing:
 *
 *  - `lastBusyAt` is the last time this pool had observed work, a busy
 *    runner, incomplete evidence, or a reset after startup or a failed pass. The idle
 *    cooldown counts from it, and no API call answers "when was that".
 *  - `shortfallSince` is when instances first outnumbered online runners and
 *    have ever since — a duration across passes, not a fact about one.
 *
 * The current instance count is deliberately absent: it is read from Cloud Run
 * in the pass that uses it, which is both fresher and one less thing to keep
 * honest.
 */
export interface PoolState {
  lastBusyAt?: number | null;
  shortfallSince?: number | null;
}

export function emptyPoolState(): PoolState {
  return { lastBusyAt: null, shortfallSince: null };
}

export interface PoolConfig {
  /** Logical name used in logs and as the store key. */
  name: string;
  /** GCP project holding the worker pool. */
  project: string;
  /** Worker pool region, e.g. `asia-northeast1`. */
  location: string;
  /** Cloud Run worker pool short name (not the fully qualified resource name). */
  workerPool: string;
  /** Label selector: every label here must appear on a job for it to match. */
  labels: string[];
  min: number;
  max: number;
  /**
   * Idle instances kept on top of current demand. `min` is a floor on the pool;
   * `warmSpare` is headroom, so `min: 1` with one job running still has no spare
   * capacity while `warmSpare: 1` does. Each spare is an instance billed around
   * the clock.
   */
  warmSpare: number;
  cooldownSeconds: number;
  /** Omitted disables reductions. Idle mitigation requires explicit opt-in. */
  scaleDown?: "idle" | "disabled";
  /**
   * `owner/repo` this pool's runners register to, when that is not
   * `GITHUB_ORG`. GitHub's runner list is scoped to wherever the registration
   * token was minted for, and asking the wrong scope returns an empty list,
   * not an error — indistinguishable from "no runners exist" unless something
   * knows to ask the other endpoint. Unset means "use `GITHUB_ORG`", which is
   * the only behaviour a config written before this field existed can have.
   */
  runnerRepo?: string;
}

/**
 * The Cloud Run resource this pool scales.
 *
 * Every component is validated at config load (see `config.ts`) so that this
 * interpolation cannot produce a path other than the one it looks like: no
 * slashes, no dot segments, no full resource names smuggled in through a
 * component. A `workerPool` of `other/../runner` would otherwise resolve to a
 * different resource than its own name suggests, which also made two pools that
 * compare as different targets scale one worker pool against each other.
 */
export function poolResourceName(pool: PoolConfig): string {
  return `projects/${pool.project}/locations/${pool.location}/workerPools/${pool.workerPool}`;
}

/**
 * The identity two pools must not share, in canonical form.
 *
 * Canonical here means "already validated into one spelling": the components
 * are lowercase, unpadded and free of anything structural, so a string
 * comparison is a resource comparison. The one alias banto cannot see through
 * is a project *number* standing for a project *id*, which is why config
 * refuses the numeric form rather than pretending the comparison covers it.
 */
export function poolTarget(pool: PoolConfig): string {
  return `${pool.project}/${pool.location}/${pool.workerPool}`;
}

/** Injected so tests never touch the real clock. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * The slice of `fetch` banto uses. Narrower than `typeof fetch` on purpose:
 * a test double should not have to implement runtime extras like `preconnect`.
 */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A `workflow_job` webhook payload, reduced to what banto actually reads. */
export interface WorkflowJobEvent {
  action: string;
  workflow_job: {
    id: number;
    run_id?: number;
    status?: string;
    labels: string[];
  };
  repository?: { full_name?: string };
  /** Which installation of the App produced this event. */
  installation?: { id?: number };
}

/** A job as the GitHub REST API reports it. */
export interface ObservedJob {
  id: number;
  labels: string[];
  status: JobStatus;
}

/** A self-hosted runner as GitHub reports it. */
export interface ObservedRunner {
  id: number;
  name: string;
  /** GitHub's own word for "this runner is running a job right now". */
  busy: boolean;
  status: "online" | "offline";
  labels: string[];
}

/** What the runner list says about one pool, or null when it was unavailable. */
export interface RunnerObservation {
  /** Runners registered with labels matching this pool, online or not. */
  registered: number;
  online: number;
  busy: number;
}

/**
 * What one pass learned about a pool, as a type that cannot be misused.
 *
 * The safety rule is that evidence which might be partial may raise a count but
 * never lower one. Expressing that as a boolean on a record meant every reader
 * had to remember to check it, and the checks drifted: a truncated runner list
 * would set the flag on one path and not another. Here the two cases are
 * different types, and the fields a lowering decision needs — how many jobs are
 * running, what the runners say — **exist only on the complete variant**. A
 * decision that consults them has already narrowed to evidence good enough to
 * act on, or it does not compile.
 */
export type PoolEvidence = CompleteEvidence | PartialEvidence;

export interface CompleteEvidence {
  kind: "complete";
  /** Jobs queued or running for this pool right now. */
  demand: number;
  /** How many of those are already running. */
  running: number;
  /**
   * What GitHub's runner list says, or null when the cross-check is **not
   * configured** (no `GITHUB_ORG`). A cross-check that was configured and
   * failed does not produce this variant at all — missing evidence is partial
   * evidence, not absent evidence.
   */
  runners: RunnerObservation | null;
}

export interface PartialEvidence {
  kind: "partial";
  /** A lower bound: what banto managed to see before the evidence ran out. */
  demand: number;
  /** Why it is partial, for the logs. */
  reason: string;
}
