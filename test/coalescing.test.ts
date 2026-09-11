import { describe, expect, test } from "bun:test";
import { Controller } from "../src/controller.ts";
import { nullLogger } from "../src/log.ts";
import { MemoryDemandStore } from "../src/store.ts";
import type { WorkflowJobEvent } from "../src/types.ts";
import { FakeClock, FakeGitHub, FakeWorkerPools, jobsFor, pool } from "./helpers.ts";

/**
 * Webhooks are triggers, and a trigger costs a GitHub listing. These tests pin
 * down what stops a burst of deliveries from turning into a burst of API calls:
 * passes for a pool are serialised, triggers that arrive during one collapse
 * into a single follow-up, and a floor spaces passes out.
 */

const POOL = pool({ name: "default", labels: ["self-hosted", "runner-default"], max: 5 });

function event(action = "queued"): WorkflowJobEvent {
  return { action, workflow_job: { id: 1, labels: ["self-hosted", "runner-default"] } };
}

function harness(options: { minPassIntervalMs?: number } = {}) {
  const clock = new FakeClock();
  const workerPools = new FakeWorkerPools();
  const github = new FakeGitHub(jobsFor([1], ["self-hosted", "runner-default"]));
  const slept: number[] = [];
  const controller = new Controller({
    pools: [POOL],
    store: new MemoryDemandStore(),
    workerPools,
    github,
    clock,
    logger: nullLogger,
    minPassIntervalMs: options.minPassIntervalMs ?? 0,
    sleep: async (ms) => {
      slept.push(ms);
      clock.advance(ms);
    },
  });
  return { controller, clock, workerPools, github, slept };
}

describe("pass coalescing", () => {
  test("a burst of deliveries collapses into two passes, not ten", async () => {
    // One pass in flight plus one queued behind it: a later pass sees
    // everything the intervening triggers would have shown, because it reads
    // the world rather than a backlog.
    const h = harness();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.github.beforeObserve = () => gate;

    const deliveries = Array.from({ length: 10 }, () => h.controller.handleWorkflowJob(event()));
    await Promise.resolve();
    release();
    await Promise.all(deliveries);

    expect(h.github.calls).toBe(2);
  });

  test("every caller waits for a pass that started after it asked", async () => {
    // A 2xx on the webhook has to mean "banto has looked" — including for the
    // deliveries that coalesced.
    const h = harness();
    const seen: number[] = [];
    h.github.beforeObserve = async () => {
      seen.push(h.github.calls);
    };
    const [a, b] = await Promise.all([
      h.controller.handleWorkflowJob(event()),
      h.controller.handleWorkflowJob(event()),
    ]);
    // `a.handled && a.decision` would be satisfied by `handled: false`, since
    // `false` is defined. Assert the two things separately.
    expect(a.handled).toBe(true);
    expect(b.handled).toBe(true);
    expect(a.handled && a.decision).toBeDefined();
    expect(b.handled && b.decision).toBeDefined();
    // The claim in the name, made concrete. The second delivery arrives while
    // the first pass is already running, so it does not read that pass's
    // result — it joins the follow-up, and is answered by a pass that began
    // after it asked. Two passes, in order. (`seen` records the counter after
    // the increment, so they read as 1 and 2.)
    expect(seen).toEqual([1, 2]);
  });

  test("passes for a pool never overlap", async () => {
    const h = harness();
    let concurrent = 0;
    let overlapped = false;
    h.github.beforeObserve = async () => {
      concurrent += 1;
      if (concurrent > 1) overlapped = true;
      await Promise.resolve();
      concurrent -= 1;
    };
    await Promise.all([
      h.controller.handleWorkflowJob(event()),
      h.controller.handleWorkflowJob(event()),
      h.controller.handleWorkflowJob(event()),
    ]);
    expect(overlapped).toBe(false);
  });

  test("a failed pass does not poison the ones queued behind it", async () => {
    const h = harness();
    let first = true;
    h.github.beforeObserve = async () => {
      if (!first) return;
      first = false;
      throw new Error("transient");
    };
    const results = await Promise.allSettled([
      h.controller.handleWorkflowJob(event()),
      h.controller.handleWorkflowJob(event()),
    ]);
    // The listing failure is swallowed as "incomplete evidence", so both
    // callers get a decision; what matters is that neither hangs.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(h.workerPools.countOf("default")).toBe(1);
  });

  test("triggers after a pass finishes start a new one", async () => {
    const h = harness();
    await h.controller.handleWorkflowJob(event());
    await h.controller.handleWorkflowJob(event());
    expect(h.github.calls).toBe(2);
  });
});

describe("the minimum pass interval", () => {
  test("spaces passes out, because each one spends API budget", async () => {
    const h = harness({ minPassIntervalMs: 10_000 });
    await h.controller.handleWorkflowJob(event());
    await h.controller.handleWorkflowJob(event());
    expect(h.slept).toEqual([10_000]);
    expect(h.github.calls).toBe(2);
  });

  test("does not delay the first pass for a pool", async () => {
    const h = harness({ minPassIntervalMs: 10_000 });
    await h.controller.handleWorkflowJob(event());
    expect(h.slept).toEqual([]);
  });

  test("does not wait when enough time has already passed", async () => {
    const h = harness({ minPassIntervalMs: 10_000 });
    await h.controller.handleWorkflowJob(event());
    h.clock.advance(30_000);
    await h.controller.handleWorkflowJob(event());
    expect(h.slept).toEqual([]);
  });
});
