import { describe, expect, test } from "bun:test";
import { LaunchNotSubmitted, type RunnerExecution, type RunnerExecutionClient } from "../src/cloudrun-jobs.ts";
import { Controller } from "../src/controller.ts";
import { ExecutionScaler, MAX_STARTS_PER_PASS } from "../src/executions.ts";
import type { RunnerRegistrar } from "../src/github.ts";
import { HttpError } from "../src/http.ts";
import { nullLogger } from "../src/log.ts";
import { MemoryDemandStore } from "../src/store.ts";
import type { PoolConfig, RunnerLaunch } from "../src/types.ts";
import { FakeClock, FakeGitHub, FakeWorkerPools, jobsFor, pool } from "./helpers.ts";

class Executions implements RunnerExecutionClient {
  starts: { launch: RunnerLaunch; config: string }[] = [];
  items = new Map<string, RunnerExecution>();
  failure: Error | null = null;
  acceptedBeforeFailure = false;
  hidden = false;
  async start(_pool: PoolConfig, launch: RunnerLaunch, config: string) {
    this.starts.push({ launch, config });
    const name = `projects/test-project/locations/asia-northeast1/jobs/runner/executions/runner-${this.starts.length}`;
    if (!this.failure || this.acceptedBeforeFailure) this.items.set(launch.id, { name, launchId: launch.id, terminal: false, failed: false });
    if (this.failure) throw this.failure;
    return { operation: `projects/test-project/locations/asia-northeast1/operations/op-${this.starts.length}`, execution: name };
  }
  async observe(_pool: PoolConfig, launch: RunnerLaunch) { return this.items.get(launch.id) ?? null; }
  async find(_pool: PoolConfig, ids: readonly string[]) { return this.hidden ? [] : [...this.items.values()].filter((e) => ids.includes(e.launchId!)); }
  complete(failed = false) { for (const e of this.items.values()) { e.terminal = true; e.failed = failed; } }
}

function scenario(max = 5) {
  const config = pool({ backend: "jobs", job: "runner", max });
  const clock = new FakeClock();
  const github = new FakeGitHub();
  const client = new Executions();
  const store = new MemoryDemandStore();
  const workerPools = new FakeWorkerPools();
  workerPools.beforeGet = async () => { throw new Error("jobs must not read aggregate worker pool capacity"); };
  const created: string[] = [];
  const removed: number[] = [];
  const registrar: RunnerRegistrar = {
    async createJitRunner(_pool, name) { created.push(name); return { runnerId: created.length, config: `one-job-secret-${created.length}` }; },
    async removeRunner(_pool, id) { removed.push(id); },
  };
  const makeController = () => new Controller({ pools: [config], clock, github, store, workerPools, logger: nullLogger,
    minPassIntervalMs: 0, executions: new ExecutionScaler({ store, client, registrar, clock, logger: nullLogger }) });
  const controller = makeController();
  const demand = (n: number) => { github.jobs = jobsFor(Array.from({ length: n }, (_, i) => i + 1), config.labels); };
  return { config, clock, github, client, store, created, removed, registrar, controller, makeController, demand };
}

describe("serverless execution lifecycle", () => {
  test("scales zero to many to zero without cancelling any running execution", async () => {
    const h = scenario();
    expect((await h.controller.reconcile()).decisions[0]?.target).toBe(0);
    h.demand(3);
    expect((await h.controller.reconcile()).decisions[0]?.target).toBe(3);
    expect(h.created).toHaveLength(3);
    expect(h.client.starts.map((s) => s.config)).toEqual(["one-job-secret-1", "one-job-secret-2", "one-job-secret-3"]);
    h.demand(0);
    expect((await h.controller.reconcile()).decisions[0]?.outcome).toBe("awaiting_completion");
    expect(h.removed).toEqual([]);
    h.client.complete();
    expect((await h.controller.reconcile()).decisions[0]?.target).toBe(0);
    expect(h.removed).toEqual([1, 2, 3]);
    expect(h.github.runnerCalls).toBe(0);
    expect((await h.store.get("default")).state.executions?.launches).toEqual([]);
  });

  test("duplicate triggers and restart do not duplicate live runners", async () => {
    const h = scenario(); h.demand(3);
    await Promise.all([h.controller.reconcile(), h.controller.reconcile(), h.controller.reconcile()]);
    await h.makeController().reconcile();
    expect(h.client.starts).toHaveLength(3);
  });

  test("new demand starts while older executions are finishing", async () => {
    const h = scenario(); h.demand(2);
    await h.controller.reconcile();
    h.demand(4);
    expect((await h.controller.reconcile()).decisions[0]?.target).toBe(4);
    const [first] = h.client.items.values();
    first!.terminal = true;
    h.demand(3);
    expect((await h.controller.reconcile()).decisions[0]?.target).toBe(3);
    expect(h.client.starts).toHaveLength(4);
  });

  test("startup counts toward max and each pass has a bounded launch budget", async () => {
    const h = scenario(100); h.demand(200);
    await h.controller.reconcile();
    expect(h.client.starts).toHaveLength(MAX_STARTS_PER_PASS);
    for (let i = 0; i < 12; i++) await h.controller.reconcile();
    expect(h.client.starts).toHaveLength(100);
  });

  test("partial GitHub evidence can grow capacity but cannot retire an execution", async () => {
    const h = scenario(); h.demand(2); h.github.jobsComplete = false;
    const result = await h.controller.reconcile();
    expect(result.decisions[0]?.target).toBe(2);
    expect(result.evidenceComplete).toBe(false);
    h.demand(0);
    await h.controller.reconcile();
    expect(h.removed).toEqual([]);
  });
});

describe("launch failure recovery and cost bounds", () => {
  test("an accepted POST with a lost response is discovered without replay", async () => {
    const h = scenario(); h.demand(1);
    h.client.failure = new Error("transport unavailable"); h.client.acceptedBeforeFailure = true;
    expect((await h.controller.reconcile()).failures).toHaveLength(1);
    h.client.failure = null;
    expect((await h.makeController().reconcile()).decisions[0]?.target).toBe(1);
    expect(h.client.starts).toHaveLength(1);
    expect(h.removed).toEqual([]);
  });

  test("a state write lost after POST acceptance preserves its reservation", async () => {
    const h = scenario(); h.demand(1);
    const put = h.store.put.bind(h.store);
    let writes = 0;
    h.store.put = async (...args) => {
      if (++writes === 3) throw new Error("state unavailable");
      return put(...args);
    };
    expect((await h.controller.reconcile()).failures).toHaveLength(1);
    h.store.put = put;
    await h.makeController().reconcile();
    expect(h.client.starts).toHaveLength(1);
    h.client.complete(); h.demand(0);
    expect((await h.controller.reconcile()).decisions[0]?.target).toBe(0);
  });

  test("unknown launches are not forgotten after empty listings or a long outage", async () => {
    const h = scenario(1); h.demand(1);
    h.client.failure = new Error("lost response");
    await h.controller.reconcile();
    h.client.failure = null; h.client.hidden = true;
    h.clock.advance(7 * 86_400_000);
    await h.makeController().reconcile();
    expect(h.client.starts).toHaveLength(1);
    expect((await h.store.get("default")).state.executions?.launches).toHaveLength(1);
  });

  test("a reservation write failure sends no JIT or execution request", async () => {
    const h = scenario(); h.demand(1);
    h.store.put = async () => { throw new Error("unavailable"); };
    expect((await h.controller.reconcile()).failures).toHaveLength(1);
    expect(h.created).toEqual([]);
    expect(h.client.starts).toEqual([]);
  });

  for (const error of [new LaunchNotSubmitted("template invalid"), new HttpError("run", 403)]) {
    test(`${error.name} before accepted launch releases the slot and backs off`, async () => {
      const h = scenario(); h.demand(1); h.client.failure = error;
      await h.controller.reconcile();
      expect((await h.store.get("default")).state.executions?.launches).toEqual([]);
      expect(h.removed).toEqual([1]);
      expect((await h.controller.reconcile()).decisions[0]?.outcome).toBe("blocked_launch_backoff");
      h.client.failure = null; h.clock.advance(30_000);
      expect((await h.controller.reconcile()).decisions[0]?.target).toBe(1);
    });
  }

  test("repeated failed tasks increase backoff rather than creating a tight billing loop", async () => {
    const h = scenario(); h.demand(1);
    await h.controller.reconcile(); h.client.complete(true);
    expect((await h.controller.reconcile()).decisions[0]?.outcome).toBe("blocked_launch_backoff");
    h.clock.advance(30_000); await h.controller.reconcile(); h.client.complete(true);
    await h.controller.reconcile();
    expect((await h.store.get("default")).state.executions?.retryAfter).toBe(h.clock.now() + 60_000);
  });

  test("wrong execution identity cannot retire a reservation", async () => {
    const h = scenario(); h.demand(1); await h.controller.reconcile();
    const [execution] = h.client.items.values(); execution!.launchId = "wrong"; execution!.terminal = true;
    expect((await h.controller.reconcile()).failures).toHaveLength(1);
    expect(h.removed).toEqual([]);
  });

  test("rejected-launch cleanup survives failure and restart without becoming an unknown run", async () => {
    const h = scenario(1); h.demand(1);
    h.client.failure = new LaunchNotSubmitted("invalid template");
    const remove = h.registrar.removeRunner;
    h.registrar.removeRunner = async () => { throw new Error("GitHub unavailable"); };
    expect((await h.controller.reconcile()).failures).toHaveLength(1);
    const launches = (await h.store.get("default")).state.executions?.launches;
    expect(launches?.[0]?.notSubmitted).toBe(true);
    expect(launches?.[0]?.runnerId).toBe(1);
    h.registrar.removeRunner = remove;
    expect((await h.makeController().reconcile()).decisions[0]?.outcome).toBe("blocked_launch_backoff");
    expect(h.removed).toEqual([1]);
    expect((await h.store.get("default")).state.executions?.launches).toEqual([]);
    expect(h.client.starts).toHaveLength(1);
  });

  test("terminal cleanup failure retains ownership until GitHub recovers", async () => {
    const h = scenario(); h.demand(1); await h.controller.reconcile();
    h.client.complete(); h.demand(0);
    const remove = h.registrar.removeRunner;
    h.registrar.removeRunner = async () => { throw new Error("GitHub unavailable"); };
    expect((await h.controller.reconcile()).failures).toHaveLength(1);
    expect((await h.store.get("default")).state.executions?.launches).toHaveLength(1);
    h.registrar.removeRunner = remove;
    expect((await h.makeController().reconcile()).decisions[0]?.target).toBe(0);
    expect(h.client.starts).toHaveLength(1);
  });
});
