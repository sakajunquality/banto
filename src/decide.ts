import type { PoolConfig, PoolEvidence, PoolState, RunnerObservation } from "./types.ts";

/**
 * The scaling decision, as a pure function of (config, this pass's observation
 * of GitHub, the pool's current instance count, the cooldown anchor, now).
 *
 * Up is easy: a queued job wants a runner, so raise the count immediately.
 *
 * Down is where the hazard is. Lowering `manualInstanceCount` lets Cloud Run
 * pick which instance to stop, and it may pick one that is in the middle of a
 * job. An ephemeral runner turns that into a failed job rather than a lost one,
 * but a failed job is still a failure someone has to re-run. So banto only
 * scales down when all of:
 *
 *   1. the listing is complete — partial evidence may never lower a count;
 *   2. no job for this pool is running, per that listing;
 *   3. no runner for this pool is busy, per GitHub's runner list; and
 *   4. either that runner list positively shows idle runners, or
 *      `cooldownSeconds` have passed since the last pass in which every
 *      instance was justified (demand at least matched the count, or a runner
 *      was busy).
 *
 * The runner list is the better signal by a wide margin: `busy` is GitHub's own
 * statement about the runner that would be stopped. The cooldown is the
 * fallback for when that list is unavailable.
 */

export type DecisionOutcome =
  | "scale_up"
  | "scale_down"
  | "unchanged"
  | "blocked_incomplete_evidence"
  | "blocked_in_progress"
  | "blocked_runner_busy"
  | "blocked_cooldown";

export interface Decision {
  pool: string;
  demand: number;
  current: number;
  /** What the observation alone asks for, after clamping. */
  desired: number;
  /** What banto will actually write, which equals `current` when it holds. */
  target: number;
  outcome: DecisionOutcome;
  /** True only when `target !== current`; banto never writes a no-op update. */
  write: boolean;
  /** Seconds left on the idle cooldown, when that is what is holding. */
  cooldownRemainingSeconds?: number;
  /** What allowed a scale-down: a positive idle runner list, or the cooldown. */
  idleEvidence?: "runners" | "cooldown";
  /** False when this decision was made on evidence that might be partial. */
  evidenceComplete: boolean;
}

/**
 * How far in the future a stored anchor may be before it is unusable.
 *
 * A record of "last busy" cannot legitimately be ahead of now, but a clock that
 * stepped, a store that wrote from a skewed instance, or a hand-edited value can
 * all produce one — and an anchor in the future never elapses, so the pool it
 * belongs to would be blocked for as long as the value stands.
 */
export const ANCHOR_SKEW_MS = 60_000;

/**
 * Read a stored cooldown anchor, or say it cannot be used.
 *
 * The policy lives here rather than in the two codecs, because a rule about
 * what a timestamp *means* duplicated in two places is a rule that will drift.
 * A codec's job is to say what was stored; this says whether it is usable.
 */
export function usableAnchor(value: number | null | undefined, now: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  if (value > now + ANCHOR_SKEW_MS) return null;
  return value;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function decide(
  pool: PoolConfig,
  evidence: PoolEvidence,
  state: PoolState,
  current: number,
  now: number,
): Decision {
  // `min` is a floor on the pool; `warmSpare` is headroom on top of demand.
  const desired = clamp(evidence.demand + pool.warmSpare, pool.min, pool.max);
  const base = {
    pool: pool.name,
    demand: evidence.demand,
    current,
    desired,
    evidenceComplete: evidence.kind === "complete",
  };

  if (desired === current) {
    return { ...base, target: current, outcome: "unchanged", write: false };
  }

  if (desired > current) {
    // Raising a count on partial evidence is safe: what banto saw is a lower
    // bound on the work waiting.
    return { ...base, target: desired, outcome: "scale_up", write: true };
  }

  // Below this line the decision would lower the count, so it needs evidence
  // good enough to act on. The narrowing is what makes `running` and `runners`
  // reachable at all.
  if (evidence.kind === "partial") {
    return { ...base, target: current, outcome: "blocked_incomplete_evidence", write: false };
  }

  if (evidence.running > 0) {
    return { ...base, target: current, outcome: "blocked_in_progress", write: false };
  }

  const runners = evidence.runners;
  // GitHub says a runner in this pool is running something. Never shrink the
  // pool under it.
  if (runners !== null && runners.busy > 0) {
    return { ...base, target: current, outcome: "blocked_runner_busy", write: false };
  }

  // Online runners, none of them busy, nothing queued: direct evidence that
  // stopping an instance stops an idle one. An empty runner list is not that —
  // it is the staffing-failure case — so it falls through to the cooldown.
  if (runners !== null && runners.online > 0 && runners.busy === 0) {
    return { ...base, target: desired, outcome: "scale_down", write: true, idleEvidence: "runners" };
  }

  const cooldownMs = pool.cooldownSeconds * 1000;
  const lastBusyAt = usableAnchor(state.lastBusyAt, now);
  // A missing or unusable anchor means the record of when this pool was last
  // busy is gone — a failed state write, a corrupt value, a clock that stepped.
  // Reading that as "never busy" would satisfy the cooldown instantly and scale
  // the pool away; reading it as "busy just now" costs one cooldown of
  // capacity. Take the side that keeps capacity — and note that the pass
  // repairs the stored value, so this costs exactly one cooldown rather than
  // blocking the pool for as long as the bad value stands.
  const idleFor = lastBusyAt === null ? 0 : Math.max(0, now - lastBusyAt);
  if (idleFor < cooldownMs) {
    return {
      ...base,
      target: current,
      outcome: "blocked_cooldown",
      write: false,
      cooldownRemainingSeconds: Math.ceil((cooldownMs - idleFor) / 1000),
    };
  }

  return { ...base, target: desired, outcome: "scale_down", write: true, idleEvidence: "cooldown" };
}

/**
 * How long a pool may have more instances than registered runners before that
 * counts as a staffing failure rather than a cold start. Instances take tens of
 * seconds to register; minutes means something is wrong (a bad App key, an
 * image that cannot pull, a crash loop).
 */
export const SUSTAINED_SHORTFALL_MS = 5 * 60 * 1000;

/**
 * Fold this pass's staffing observation into the state.
 *
 * `shortfallSince` is the moment the pool first had more instances than online
 * runners and has had ever since; it resets as soon as the runners catch up,
 * and stays null when the runner list was unavailable.
 */
export function trackStaffing(
  state: PoolState,
  instanceCount: number,
  runners: RunnerObservation | null,
  at: number,
): { state: PoolState; shortfall: number; sustainedFor: number | null } {
  if (runners === null) return { state, shortfall: 0, sustainedFor: null };

  // Compared against *online* runners: an offline registration staffs nothing.
  const shortfall = Math.max(0, instanceCount - runners.online);
  if (shortfall === 0) {
    return { state: { ...state, shortfallSince: null }, shortfall, sustainedFor: null };
  }
  const since = state.shortfallSince ?? at;
  return { state: { ...state, shortfallSince: since }, shortfall, sustainedFor: Math.max(0, at - since) };
}
