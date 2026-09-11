import { describe, expect, test } from "bun:test";
import { Controller } from "../src/controller.ts";
import { nullLogger } from "../src/log.ts";
import { MemoryDemandStore } from "../src/store.ts";
import type { ObservedJob, PoolConfig, WorkflowJobEvent } from "../src/types.ts";
import { FakeClock, FakeWorkerPools, jobsFor, pool } from "./helpers.ts";
import { ControllableGitHub, gate } from "./world.ts";

/**
 * Interleaving tests: the shape of test that catches evidence gathered at one
 * moment and used at another.
 *
 * Ordinary behavioural tests could not find this class, because they call one
 * entry point at a time and assert on its result — the same assumption the code
 * was making. These tests hold a pass open at a named point, run something else
 * to completion in that window, and then let it continue. Each one is a
 * reproduction of a bug that a green suite did not catch.
 */

const DEFAULT = pool({ name: "default", labels: ["self-hosted", "runner-default"], max: 4 });
const BUILD = pool({ name: "build", labels: ["self-hosted", "runner-build"], max: 4 });

function event(pool: "default" | "build"): WorkflowJobEvent {
  return { action: "queued", workflow_job: { id: 1, labels: ["self-hosted", `runner-${pool}`] } };
}

function harness(options: { pools?: PoolConfig[]; counts?: Record<string, number>; jobs?: ObservedJob[] } = {}) {
  const clock = new FakeClock();
  const workerPools = new FakeWorkerPools(options.counts ?? {});
  const github = new ControllableGitHub(options.jobs ?? []);
  const controller = new Controller({
    pools: options.pools ?? [DEFAULT, BUILD],
    store: new MemoryDemandStore(),
    workerPools,
    github,
    clock,
    logger: nullLogger,
    minPassIntervalMs: 0,
  });
  return { controller, clock, workerPools, github };
}

describe("evidence cannot be gathered before the work that uses it", () => {
  test("a reconcile stalled on one pool does not act on stale evidence for another", async () => {
    // The original bug: reconcile fetched one listing for every pool, then
    // queued behind pool A. While it waited, pool B became busy, and reconcile
    // scaled B down using the idle reading it had taken before.
    const h = harness({ counts: { build: 0 } });
    const held = gate();
    // What the world looked like at the moment each listing was taken. The bug
    // is about *when* the evidence for a pool was gathered, so the test has to
    // assert on that rather than only on the final count — the final count is
    // also reached by an implementation that never looked.
    const buildCountWhenObserved: number[] = [];
    h.github.beforeJobs = async (call) => {
      buildCountWhenObserved.push(h.workerPools.countOf("build"));
      // Hold the first pass (pool "default") open.
      if (call === 1) await held.promise;
    };

    const reconciling = h.controller.reconcile();
    await Promise.resolve();

    // While that pass is stuck, work arrives for the *other* pool and a webhook
    // raises it.
    h.github.jobs = jobsFor([9], ["self-hosted", "runner-build"]);
    await h.controller.handleWorkflowJob(event("build"));
    expect(h.workerPools.countOf("build")).toBe(1);

    held.open();
    await reconciling;

    // The build pool must not be scaled down.
    expect(h.workerPools.countOf("build")).toBe(1);
    // And for the right reason. One listing per pool, not one shared listing
    // gathered up front — that shared listing is the bug. The second was taken
    // after the webhook had raised the build pool, so the decision for "build"
    // rests on an observation that includes the new job.
    // Three listings: reconcile's held pass for "default", the webhook's own
    // pass for "build", then reconcile's pass for "build". The last is the one
    // that matters — it was taken when the build pool already stood at 1, so
    // the decision not to scale it down rests on an observation that includes
    // the new job. A single listing gathered up front would be one call, taken
    // while the build pool was still empty.
    expect(h.github.calls).toBe(3);
    expect(buildCountWhenObserved).toEqual([0, 0, 1]);
  });

  test("a trigger that joins a queued pass is seen by it", async () => {
    // The original bug: the queued pass closed over the evidence its *first*
    // trigger had fetched, so a job that queued afterwards was invisible to it
    // and the webhook returned a decision for demand 0.
    const h = harness({ pools: [DEFAULT] });
    const held = gate();
    h.github.beforeJobs = async (call) => {
      if (call === 1) await held.promise;
    };

    const first = h.controller.handleWorkflowJob(event("default"));
    await Promise.resolve();

    // The second webhook joins the queued follow-up rather than starting a pass.
    const second = h.controller.handleWorkflowJob(event("default"));
    await Promise.resolve();

    // Only now does the job queue — *after* the trigger that will be answered
    // by the follow-up has already joined it. Setting this before the second
    // trigger, as this test used to, cannot tell the two implementations apart:
    // evidence captured at trigger time and evidence fetched at pass time both
    // contain the job.
    h.github.jobs = jobsFor([1], ["self-hosted", "runner-default"]);

    held.open();
    const [, secondOutcome] = await Promise.all([first, second]);

    // The follow-up did its own listing rather than reusing the held pass's.
    expect(h.github.calls).toBe(2);
    expect(secondOutcome.handled && secondOutcome.decision.demand).toBe(1);
    expect(h.workerPools.countOf("default")).toBe(1);
  });

  test("the interval floor is waited out before anything is fetched", async () => {
    // If the wait came after the fetch, a queue of triggers would each hold an
    // observation that aged while they waited — and the floor would bound the
    // writes but not the API spend it exists to bound.
    const clock = new FakeClock();
    const github = new ControllableGitHub([]);
    const order: string[] = [];
    const controller = new Controller({
      pools: [DEFAULT],
      store: new MemoryDemandStore(),
      workerPools: new FakeWorkerPools(),
      github,
      clock,
      logger: nullLogger,
      minPassIntervalMs: 10_000,
      sleep: async (ms) => {
        order.push(`sleep:${ms}`);
        clock.advance(ms);
      },
    });
    github.beforeJobs = async () => {
      order.push("fetch");
    };

    await controller.handleWorkflowJob(event("default"));
    await controller.handleWorkflowJob(event("default"));
    expect(order).toEqual(["fetch", "sleep:10000", "fetch"]);
  });

  test("a job that appears between the fetch and the write is corrected by the next pass", async () => {
    // banto cannot see the future, so it may write a count that is already out
    // of date — but the *next* pass must correct it rather than the stale one
    // standing.
    //
    // The first pass here exists only to seed the cooldown anchor: a pool with
    // no stored state is treated as "busy just now", so without it every pass
    // below returns `blocked_cooldown`, the write is never reached, the gate
    // never runs, and the test passes while exercising nothing. It did exactly
    // that until the hook-call assertions below were added.
    const h = harness({ pools: [DEFAULT], counts: { default: 1 } });
    await h.controller.reconcile();
    expect(h.workerPools.writes).toEqual([]);

    let hookCalls = 0;
    const held = gate();
    h.workerPools.beforeWrite = async () => {
      hookCalls += 1;
      if (h.workerPools.writes.length > 0) return;
      h.github.jobs = jobsFor([1], ["self-hosted", "runner-default"]);
      await held.promise;
    };

    // Past the cooldown, the empty queue now justifies scaling to zero.
    h.clock.advance(10 * 60_000);
    const first = h.controller.reconcile();
    await Promise.resolve();
    held.open();
    await first;

    // The window was actually entered, and the stale write actually landed.
    expect(hookCalls).toBe(1);
    expect(h.workerPools.writes).toEqual([{ pool: "default", count: 0 }]);
    expect(h.workerPools.countOf("default")).toBe(0);

    // The next pass sees the job and puts the instance back.
    await h.controller.handleWorkflowJob(event("default"));
    expect(h.workerPools.writes.at(-1)).toEqual({ pool: "default", count: 1 });
    expect(h.workerPools.countOf("default")).toBe(1);
  });
});
