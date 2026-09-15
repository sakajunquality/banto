import { describe, expect, test } from "bun:test";
import { clamp, decide, SUSTAINED_SHORTFALL_MS, trackStaffing, usableAnchor } from "../src/decide.ts";
import type { PoolEvidence, PoolState, RunnerObservation } from "../src/types.ts";
import { emptyPoolState } from "../src/types.ts";
import { pool } from "./helpers.ts";

const T0 = 1_700_000_000_000;

const runners = (online: number, busy: number): RunnerObservation => ({ registered: online, online, busy });

/** Complete evidence: what an ordinary pass produces. */
function seen(demand: number, running = 0, runnerView: RunnerObservation | null = null): PoolEvidence {
  return { kind: "complete", demand, running, runners: runnerView };
}

/** Evidence that might be partial: it may raise a count, never lower one. */
function glimpsed(demand: number, reason = "job listing incomplete"): PoolEvidence {
  return { kind: "partial", demand, reason };
}

function idleSince(at: number | null): PoolState {
  return { ...emptyPoolState(), lastBusyAt: at };
}

describe("clamp", () => {
  test("holds the floor and the ceiling", () => {
    expect(clamp(0, 1, 5)).toBe(1);
    expect(clamp(9, 1, 5)).toBe(5);
    expect(clamp(3, 1, 5)).toBe(3);
  });
});

describe("scaling decisions", () => {
  test("scales up when work is waiting", () => {
    const decision = decide(pool(), seen(1), emptyPoolState(), 0, T0);
    expect(decision.outcome).toBe("scale_up");
    expect(decision.target).toBe(1);
  });

  test("scale-up is not delayed by the cooldown", () => {
    expect(decide(pool(), seen(1), idleSince(T0 - 1_000), 0, T0).outcome).toBe("scale_up");
  });

  test("demand above max is clamped to max", () => {
    const decision = decide(pool({ max: 3 }), seen(9), emptyPoolState(), 0, T0);
    expect(decision.demand).toBe(9);
    expect(decision.target).toBe(3);
  });

  test("demand below min is raised to min", () => {
    expect(decide(pool({ min: 2 }), seen(0), idleSince(T0), 0, T0).desired).toBe(2);
  });

  test("writes nothing when the pool is already at the desired count", () => {
    const decision = decide(pool(), seen(1), emptyPoolState(), 1, T0);
    expect(decision.outcome).toBe("unchanged");
    expect(decision.write).toBe(false);
  });

  test("refuses to scale down while the listing shows a job running", () => {
    const decision = decide(pool(), seen(1, 1), idleSince(T0 - 3_600_000), 2, T0);
    expect(decision.outcome).toBe("blocked_in_progress");
  });

  test("refuses to scale down before the idle cooldown has passed", () => {
    const decision = decide(pool({ cooldownSeconds: 300 }), seen(0), idleSince(T0 - 60_000), 2, T0);
    expect(decision.outcome).toBe("blocked_cooldown");
    expect(decision.cooldownRemainingSeconds).toBe(240);
  });

  test("scales down once the cooldown has elapsed", () => {
    const decision = decide(pool({ cooldownSeconds: 300 }), seen(0), idleSince(T0 - 300_000), 2, T0);
    expect(decision.outcome).toBe("scale_down");
    expect(decision.idleEvidence).toBe("cooldown");
    expect(decision.target).toBe(0);
  });

  test("scales down to min, not below it", () => {
    expect(decide(pool({ min: 1, cooldownSeconds: 0 }), seen(0), idleSince(T0 - 1), 4, T0).target).toBe(1);
  });
});

describe("the cooldown anchor", () => {
  test("a missing anchor reads as busy just now, not busy never", () => {
    // A lost or corrupt anchor is a gap in the record. Reading it as "never
    // busy" satisfies the cooldown instantly and scales the pool away; reading
    // it as "busy now" costs one cooldown of capacity.
    const decision = decide(pool({ cooldownSeconds: 300 }), seen(0), idleSince(null), 2, T0);
    expect(decision.outcome).toBe("blocked_cooldown");
    expect(decision.cooldownRemainingSeconds).toBe(300);
  });

  test("a clock that jumped backwards does not read as a satisfied cooldown", () => {
    const decision = decide(pool({ cooldownSeconds: 300 }), seen(0), idleSince(T0 + 60_000), 2, T0);
    expect(decision.outcome).toBe("blocked_cooldown");
    expect(decision.cooldownRemainingSeconds).toBe(300);
  });

  test("idle runners cannot bypass a missing cooldown anchor", () => {
    const decision = decide(pool({ cooldownSeconds: 300 }), seen(0, 0, runners(2, 0)), idleSince(null), 2, T0);
    expect(decision.outcome).toBe("blocked_cooldown");
    expect(decision.write).toBe(false);
  });
});

describe("evidence that might be partial", () => {
  test("never lowers a count", () => {
    const decision = decide(pool(), glimpsed(0), idleSince(T0 - 3_600_000), 3, T0);
    expect(decision.outcome).toBe("blocked_incomplete_evidence");
    expect(decision.write).toBe(false);
    expect(decision.target).toBe(3);
    expect(decision.evidenceComplete).toBe(false);
  });

  test("may still raise one, because what it saw is a lower bound", () => {
    const decision = decide(pool(), glimpsed(2), emptyPoolState(), 0, T0);
    expect(decision.outcome).toBe("scale_up");
    expect(decision.target).toBe(2);
  });

  test("carries no running count or runner view for a decision to consult", () => {
    // The point of the union: the fields a lowering decision needs do not exist
    // on the partial variant, so no lowering path can read them by accident.
    const partial = glimpsed(0);
    expect("running" in partial).toBe(false);
    expect("runners" in partial).toBe(false);
  });
});

describe("runner evidence", () => {
  test("a busy runner blocks a scale-down the cooldown would have allowed", () => {
    const decision = decide(pool(), seen(0, 0, runners(2, 1)), idleSince(T0 - 3_600_000), 2, T0);
    expect(decision.outcome).toBe("blocked_runner_busy");
  });

  test("idle runners must wait for the cooldown", () => {
    const decision = decide(pool({ cooldownSeconds: 300 }), seen(0, 0, runners(2, 0)), idleSince(T0 - 1_000), 2, T0);
    expect(decision.outcome).toBe("blocked_cooldown");
    expect(decision.write).toBe(false);
  });

  test("an empty runner list is not evidence of idleness", () => {
    const decision = decide(pool({ cooldownSeconds: 300 }), seen(0, 0, runners(0, 0)), idleSince(T0 - 1_000), 2, T0);
    expect(decision.outcome).toBe("blocked_cooldown");
  });

  test("runner evidence does not affect scale-up", () => {
    expect(decide(pool(), seen(1, 0, runners(0, 0)), emptyPoolState(), 0, T0).outcome).toBe("scale_up");
  });
});

describe("staffing tracking", () => {
  test("records nothing when the runner list was unavailable", () => {
    const result = trackStaffing(emptyPoolState(), 3, null, T0);
    expect(result.shortfall).toBe(0);
    expect(result.sustainedFor).toBeNull();
  });

  test("more instances than online runners starts the clock and keeps it", () => {
    const first = trackStaffing(emptyPoolState(), 3, runners(1, 0), T0);
    expect(first.shortfall).toBe(2);
    expect(first.sustainedFor).toBe(0);
    expect(trackStaffing(first.state, 3, runners(1, 0), T0 + 600_000).sustainedFor).toBe(600_000);
  });

  test("the clock resets as soon as the runners catch up", () => {
    const first = trackStaffing(emptyPoolState(), 3, runners(1, 0), T0);
    const healthy = trackStaffing(first.state, 3, runners(3, 0), T0 + 60_000);
    expect(healthy.state.shortfallSince).toBeNull();
    expect(trackStaffing(healthy.state, 3, runners(1, 0), T0 + 120_000).sustainedFor).toBe(0);
  });

  test("offline registrations do not count as staffing", () => {
    expect(trackStaffing(emptyPoolState(), 2, { registered: 2, online: 0, busy: 0 }, T0).shortfall).toBe(2);
  });

  test("the sustained threshold is the alerting boundary", () => {
    const first = trackStaffing(emptyPoolState(), 2, runners(0, 0), T0);
    expect(trackStaffing(first.state, 2, runners(0, 0), T0 + SUSTAINED_SHORTFALL_MS).sustainedFor).toBe(
      SUSTAINED_SHORTFALL_MS,
    );
  });
});

describe("an anchor that cannot be trusted", () => {
  test("a future anchor is unusable, not a cooldown that never elapses", () => {
    // An anchor ahead of now never elapses, so without this the pool it belongs
    // to is blocked for as long as the value stands — days, in the repro.
    expect(usableAnchor(T0 + 10 * 60_000, T0)).toBeNull();
    expect(usableAnchor(T0 + 1_000, T0)).toBe(T0 + 1_000); // inside the skew
  });

  test("absurd values are unusable", () => {
    expect(usableAnchor(Number.NaN, T0)).toBeNull();
    expect(usableAnchor(Number.POSITIVE_INFINITY, T0)).toBeNull();
    expect(usableAnchor(0, T0)).toBeNull();
    expect(usableAnchor(-1, T0)).toBeNull();
    expect(usableAnchor(undefined, T0)).toBeNull();
    expect(usableAnchor(1e30, T0)).toBeNull();
  });

  test("an ordinary past anchor is used as it stands", () => {
    expect(usableAnchor(T0 - 3_600_000, T0)).toBe(T0 - 3_600_000);
  });

  test("a decision on an unusable anchor blocks, like a missing one", () => {
    const decision = decide(pool({ cooldownSeconds: 300 }), seen(0), idleSince(1e30), 2, T0);
    expect(decision.outcome).toBe("blocked_cooldown");
    expect(decision.cooldownRemainingSeconds).toBe(300);
  });
});
