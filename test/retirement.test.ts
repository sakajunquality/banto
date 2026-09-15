import { describe, expect, test } from "bun:test";
import { Controller } from "../src/controller.ts";
import { decide } from "../src/decide.ts";
import { nullLogger } from "../src/log.ts";
import { MemoryDemandStore } from "../src/store.ts";
import type { PoolConfig, PoolEvidence } from "../src/types.ts";
import { FakeClock, FakeGitHub, FakeWorkerPools, jobsFor, pool, runner } from "./helpers.ts";

function scenario(overrides: Partial<PoolConfig> = {}) {
  const config = pool(overrides);
  const clock = new FakeClock();
  const github = new FakeGitHub([], [runner({ id: 1 }), runner({ id: 2 })]);
  const workerPools = new FakeWorkerPools({ default: 2 });
  const store = new MemoryDemandStore();
  const controller = new Controller({
    pools: [config], clock, github, workerPools, store, logger: nullLogger, minPassIntervalMs: 0,
  });
  return { config, clock, github, workerPools, store, controller };
}

describe("aggregate scale-down limitations", () => {
  for (const min of [0, 1]) {
    test(`assignment after confirmation can race a reduction even with min=${min}`, async () => {
      // A counterexample, not a safety assertion: idle mitigation deliberately
      // cannot guarantee that every potential termination victim is idle.
      const h = scenario({ min });
      await h.controller.reconcile();
      h.clock.advance(3_600_000);
      h.workerPools.beforeWrite = async () => {
        h.github.jobs = jobsFor([1], h.config.labels, "in_progress");
        h.github.runners = [runner({ id: 1, busy: true }), runner({ id: 2 })];
      };
      expect((await h.controller.reconcile()).decisions[0]?.outcome).toBe("scale_down");
      expect(h.github.runners?.some((r) => r.busy)).toBe(true);
      expect(h.workerPools.writes).toEqual([{ pool: "default", count: min }]);
      // At min=1 Cloud Run may choose runner 1; no API argument selects runner 2.
    });
  }
});

describe("disabled scale-down", () => {
  test("an omitted policy fails closed even when configuration loading is bypassed", async () => {
    const h = scenario({ cooldownSeconds: 0 });
    delete h.config.scaleDown;
    expect((await h.controller.reconcile()).decisions[0]?.outcome).toBe("blocked_scale_down_disabled");
    h.github.jobs = jobsFor([1, 2, 3], h.config.labels);
    expect((await h.controller.reconcile()).decisions[0]?.outcome).toBe("scale_up");
    expect(h.workerPools.writes).toEqual([{ pool: "default", count: 3 }]);
  });

  test("never requests a reduction regardless of cooldown, demand, or evidence", () => {
    const now = new FakeClock().now();
    for (const cooldownSeconds of [0, 300]) {
      const config = pool({ scaleDown: "disabled", cooldownSeconds, max: 5 });
      for (const current of [0, 1, 4, 8]) {
        for (const demand of [0, 1, 3, 9]) {
          const evidence: PoolEvidence[] = [
            { kind: "partial", demand, reason: "unavailable" },
            { kind: "complete", demand, running: 0, runners: null },
            { kind: "complete", demand, running: 0, runners: { registered: 8, online: 0, busy: 0 } },
            { kind: "complete", demand, running: demand, runners: { registered: 8, online: 8, busy: 1 } },
          ];
          for (const observation of evidence) {
            const d = decide(config, observation, { lastBusyAt: now - 3_600_000 }, current, now);
            expect(d.target).toBe(Math.max(current, Math.min(demand, config.max)));
            expect(d.write).toBe(d.target > current);
          }
        }
      }
    }
  });

  test("retains capacity after failures and duplicate triggers but still grows for queued work", async () => {
    const h = scenario({ scaleDown: "disabled", cooldownSeconds: 0 });
    await h.controller.reconcile();
    h.workerPools.failNextGet = new Error("unavailable");
    expect((await h.controller.reconcile()).failures).toHaveLength(1);
    h.clock.advance(86_400_000);
    const calls = h.github.calls;
    const result = await h.controller.reconcile();
    expect(result.decisions[0]?.outcome).toBe("blocked_scale_down_disabled");
    expect(h.github.calls - calls).toBe(1);
    expect(h.workerPools.writes).toEqual([]);

    h.github.jobs = jobsFor([1, 2, 3], h.config.labels);
    await Promise.all([h.controller.reconcile(), h.controller.reconcile(), h.controller.reconcile()]);
    expect(h.workerPools.writes).toEqual([{ pool: "default", count: 3 }]);
    h.github.jobs = [];
    h.github.runners = [runner({ status: "offline" })];
    h.clock.advance(86_400_000);
    await h.controller.reconcile();
    expect(h.workerPools.countOf("default")).toBe(3);
  });
});
