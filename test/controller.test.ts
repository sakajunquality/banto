import { describe, expect, test } from "bun:test";
import { Controller } from "../src/controller.ts";
import { decide } from "../src/decide.ts";
import { nullLogger } from "../src/log.ts";
import { MemoryDemandStore } from "../src/store.ts";
import type { ObservedJob, PoolConfig, WorkflowJobEvent } from "../src/types.ts";
import { collectLogger, FakeClock, FakeGitHub, FakeWorkerPools, jobsFor, pool, runner } from "./helpers.ts";


const T0 = 1_700_000_000_000;
const DEFAULT = pool({ name: "default", labels: ["self-hosted", "runner-default"], max: 4 });
const BUILD = pool({ name: "build", labels: ["self-hosted", "runner-build"], max: 2 });

function harness(
  options: {
    pools?: PoolConfig[];
    counts?: Record<string, number>;
    jobs?: ObservedJob[];
    github?: FakeGitHub;
    logger?: ReturnType<typeof collectLogger>["logger"];
  } = {},
) {
  const clock = new FakeClock();
  const workerPools = new FakeWorkerPools(options.counts ?? {});
  const github = options.github ?? new FakeGitHub(options.jobs ?? []);
  const store = new MemoryDemandStore();
  const controller = new Controller({
    pools: options.pools ?? [DEFAULT, BUILD],
    store,
    workerPools,
    github,
    clock,
    logger: options.logger ?? nullLogger,
    // The interval is exercised on its own; elsewhere it would only add waiting.
    minPassIntervalMs: 0,
  });
  return { controller, clock, workerPools, github, store };
}

function event(action: string, labels: string[]): WorkflowJobEvent {
  return { action, workflow_job: { id: 1, labels }, repository: { full_name: "example-org/infra" } };
}

describe("a pass computes demand rather than remembering it", () => {
  test("a webhook triggers a pass, and the API's answer is the demand", async () => {
    // The payload names the pool. What is queued comes from GitHub.
    const h = harness({ jobs: jobsFor([1, 2, 3], ["self-hosted", "runner-default"]) });
    const outcome = await h.controller.handleWorkflowJob(event("queued", ["self-hosted", "runner-default"]));
    expect(outcome).toMatchObject({ handled: true, pool: "default" });
    expect(h.workerPools.countOf("default")).toBe(3);
  });

  test("a delivery for a job the API no longer lists scales back down", async () => {
    // No accumulated set to correct: the listing is the whole answer. The first
    // pass seeds the cooldown anchor, so the drop lands once it has elapsed.
    const h = harness({ jobs: [], counts: { default: 2 } });
    await h.controller.handleWorkflowJob(event("completed", ["self-hosted", "runner-default"]));
    expect(h.workerPools.countOf("default")).toBe(2);

    h.clock.advance(6 * 60_000);
    await h.controller.handleWorkflowJob(event("completed", ["self-hosted", "runner-default"]));
    expect(h.workerPools.countOf("default")).toBe(0);
  });

  test("duplicate and reordered deliveries cannot distort demand", async () => {
    // Every pass asks the same question and gets the same answer.
    const h = harness({ jobs: jobsFor([7], ["self-hosted", "runner-default"]) });
    for (const action of ["completed", "queued", "queued", "in_progress", "queued"]) {
      await h.controller.handleWorkflowJob(event(action, ["self-hosted", "runner-default"]));
    }
    expect(h.workerPools.countOf("default")).toBe(1);
    expect(h.workerPools.writes).toHaveLength(1);
  });

  test("jobs are routed to the pool their labels select", async () => {
    const h = harness({
      jobs: [...jobsFor([1], ["self-hosted", "runner-build"]), ...jobsFor([2, 3], ["self-hosted", "runner-default"])],
    });
    await h.controller.reconcile();
    expect(h.workerPools.countOf("build")).toBe(1);
    expect(h.workerPools.countOf("default")).toBe(2);
  });

  test("a job matching no pool is ignored", async () => {
    const h = harness({ jobs: jobsFor([1], ["ubuntu-latest"]) });
    const outcome = await h.controller.handleWorkflowJob(event("queued", ["ubuntu-latest"]));
    expect(outcome).toEqual({ handled: false, reason: "no_matching_pool" });
    expect(h.workerPools.writes).toEqual([]);
  });

  test("an action banto does not track triggers nothing at all", async () => {
    const h = harness({ jobs: jobsFor([1], ["self-hosted", "runner-default"]) });
    const outcome = await h.controller.handleWorkflowJob(event("waiting", ["self-hosted", "runner-default"]));
    expect(outcome).toEqual({ handled: false, reason: "ignored_action" });
    expect(h.github.calls).toBe(0);
  });

  test("a pool already at the desired count is not written to", async () => {
    const h = harness({ jobs: jobsFor([1], ["self-hosted", "runner-default"]), counts: { default: 1 } });
    await h.controller.handleWorkflowJob(event("queued", ["self-hosted", "runner-default"]));
    expect(h.workerPools.writes).toEqual([]);
  });

  test("demand is clamped by max", async () => {
    const h = harness({ jobs: jobsFor([1, 2, 3, 4, 5, 6, 7], ["self-hosted", "runner-build"]) });
    const { decisions } = await h.controller.reconcile();
    expect(h.workerPools.countOf("build")).toBe(2);
    expect(decisions.find((d) => d.pool === "build")?.demand).toBe(7);
  });

  test("warmSpare keeps headroom above the jobs that exist", async () => {
    const warm = pool({ name: "warm", labels: ["self-hosted", "warm"], warmSpare: 1, max: 4 });
    const h = harness({ pools: [warm], jobs: jobsFor([1], ["self-hosted", "warm"]) });
    await h.controller.reconcile();
    expect(h.workerPools.countOf("warm")).toBe(2);
  });
});

describe("scale-down safety", () => {
  test("a running job blocks it", async () => {
    const h = harness({
      jobs: jobsFor([1], ["self-hosted", "runner-default"], "in_progress"),
      counts: { default: 2 },
    });
    const { decisions } = await h.controller.reconcile();
    expect(decisions.find((d) => d.pool === "default")?.outcome).toBe("blocked_in_progress");
    expect(h.workerPools.countOf("default")).toBe(2);
  });

  test("a busy runner blocks it even when the queue is empty", async () => {
    const github = new FakeGitHub([], [runner({ id: 1, busy: true })]);
    const h = harness({ github, counts: { default: 2 } });
    const { decisions } = await h.controller.reconcile();
    expect(decisions.find((d) => d.pool === "default")?.outcome).toBe("blocked_runner_busy");
  });

  test("idle runners allow it without waiting out the cooldown", async () => {
    const github = new FakeGitHub([], [runner({ id: 1, busy: false })]);
    const h = harness({ github, counts: { default: 1 } });
    const { decisions } = await h.controller.reconcile();
    expect(decisions.find((d) => d.pool === "default")?.idleEvidence).toBe("runners");
    expect(h.workerPools.countOf("default")).toBe(0);
  });

  test("the cooldown counts from the last pass that saw the pool busy", async () => {
    const github = new FakeGitHub(jobsFor([1], ["self-hosted", "runner-default"]));
    const h = harness({ github });
    await h.controller.reconcile();
    expect(h.workerPools.countOf("default")).toBe(1);

    // The job is gone, but the pool was busy a moment ago.
    github.jobs = [];
    h.clock.advance(60_000);
    const first = await h.controller.reconcile();
    expect(first.decisions.find((d) => d.pool === "default")?.outcome).toBe("blocked_cooldown");
    expect(h.workerPools.countOf("default")).toBe(1);

    // Past the cooldown, it comes down.
    h.clock.advance(5 * 60_000);
    await h.controller.reconcile();
    expect(h.workerPools.countOf("default")).toBe(0);
  });

  test("an unavailable listing cannot lower a count", async () => {
    const github = new FakeGitHub([]);
    github.observeJobs = async () => {
      throw new Error("GitHub is down");
    };
    const h = harness({ github, counts: { default: 2 } });
    const result = await h.controller.reconcile();
    expect(result.evidenceComplete).toBe(false);
    expect(h.workerPools.countOf("default")).toBe(2);
  });

  test("a truncated listing cannot lower a count either", async () => {
    const github = new FakeGitHub([]);
    github.jobsComplete = false;
    const h = harness({ github, counts: { default: 2 } });
    const { decisions } = await h.controller.reconcile();
    expect(decisions.find((d) => d.pool === "default")?.outcome).toBe("blocked_incomplete_evidence");
  });

  test("but an incomplete listing may still raise one", async () => {
    const github = new FakeGitHub(jobsFor([1, 2], ["self-hosted", "runner-default"]));
    github.jobsComplete = false;
    const h = harness({ github });
    await h.controller.reconcile();
    expect(h.workerPools.countOf("default")).toBe(2);
  });

  test("an incomplete runner listing blocks a lowering outright", async () => {
    // It could be hiding the busy runner, so it is missing evidence rather than
    // a reason to fall back to the cooldown.
    const github = new FakeGitHub([], [runner({ id: 1, busy: false })]);
    github.runnersComplete = false;
    const h = harness({ github, counts: { default: 1 } });
    const { decisions } = await h.controller.reconcile();
    expect(decisions.find((d) => d.pool === "default")?.outcome).toBe("blocked_incomplete_evidence");
    expect(h.workerPools.countOf("default")).toBe(1);
  });

  test("a failed runner cross-check blocks a lowering too", async () => {
    const github = new FakeGitHub([], [runner({ id: 1, busy: false })]);
    github.runnerError = new Error("HTTP 403");
    const h = harness({ github, counts: { default: 1 } });
    const { decisions } = await h.controller.reconcile();
    expect(decisions.find((d) => d.pool === "default")?.outcome).toBe("blocked_incomplete_evidence");
  });

  test("but a cross-check that was never configured does not", async () => {
    // No GITHUB_ORG is a deployment choice, not a gap in the evidence.
    const github = new FakeGitHub([], null);
    const h = harness({ github, counts: { default: 1 } });
    await h.controller.reconcile();
    h.clock.advance(6 * 60_000);
    const { decisions } = await h.controller.reconcile();
    expect(decisions.find((d) => d.pool === "default")?.idleEvidence).toBe("cooldown");
  });

  test("a repo-scoped pool's busy runner is found at its own repo, not the org", async () => {
    // This is the production bug: five of seven deployed pools register their
    // runners to a repository, not the org, so the org-wide listing banto
    // always asked returned none of them — 0 runners, forever, for those
    // pools. Missing here is not "no runners exist", it is "asked the wrong
    // endpoint", and the difference matters because `decide()` can only refuse
    // to shrink a busy pool when it can see the busy runner. An empty listing
    // has nothing to see, so this safety layer was silently absent for those
    // pools rather than merely blocked by the cooldown.
    const github = new FakeGitHub([], []); // org-wide listing: configured, and empty
    github.runnersByRepo["example-org/repo-scoped"] = [runner({ id: 1, busy: true })];
    const repoPool = pool({ name: "repo-scoped", runnerRepo: "example-org/repo-scoped", max: 4 });
    const h = harness({ pools: [repoPool], github, counts: { "repo-scoped": 2 } });

    const { decisions } = await h.controller.reconcile();
    expect(github.runnerScopes).toEqual(["example-org/repo-scoped"]);
    expect(decisions[0]?.outcome).toBe("blocked_runner_busy");
  });

  test("a repo-scoped pool's staffing is measured against its own repo, not the org", async () => {
    // The other half of the same production bug: with no runners visible at
    // the org, banto reported a permanent, false staffing failure for
    // instances that had in fact registered — to the repo it never asked.
    const github = new FakeGitHub([], []); // org-wide listing: configured, and empty
    github.runnersByRepo["example-org/repo-scoped"] = [runner({ id: 1, busy: false }), runner({ id: 2, busy: false })];
    const repoPool = pool({ name: "repo-scoped", runnerRepo: "example-org/repo-scoped", max: 4 });
    const { logger, lines } = collectLogger();
    const h = harness({ pools: [repoPool], github, counts: { "repo-scoped": 2 }, logger });

    await h.controller.reconcile();
    h.clock.advance(6 * 60_000);
    lines.length = 0;
    await h.controller.reconcile();
    expect(lines.find((line) => line.message === "worker pool instances are not becoming runners")).toBeUndefined();
  });
});

describe("reconcile", () => {
  test("reports per-pool failures so Cloud Scheduler retries", async () => {
    const h = harness({ jobs: jobsFor([1], ["self-hosted", "runner-build"]) });
    h.workerPools.failNextGet = new Error("HTTP 503 from Cloud Run");
    const result = await h.controller.reconcile();
    expect(result.failures).toEqual([{ pool: "default", error: "HTTP 503 from Cloud Run" }]);
    expect(h.workerPools.countOf("build")).toBe(1);
  });

  test("each pool fetches its own evidence inside its own pass", async () => {
    // The cost of not handing observations between pools: two pools, two
    // listings. What it buys is that no observation can age while a pool waits.
    const h = harness({ jobs: [] });
    await h.controller.reconcile();
    expect(h.github.calls).toBe(2);
    expect(h.github.runnerCalls).toBe(2);
  });

  test("two pools sharing one runnerRepo still fetch it separately, for the same reason", async () => {
    // Deliberate, not an oversight: sharing one runner listing between pools
    // in the same reconcile would mean the second pool decides on evidence
    // gathered before the first pool's pass even started, which is exactly the
    // staleness this design refuses to accept for the job listing. A shared
    // scope does not change that argument, so it is not special-cased.
    const shared = "example-org/shared-repo";
    const a = pool({ name: "a", labels: ["self-hosted", "a"], runnerRepo: shared, max: 3 });
    const b = pool({ name: "b", labels: ["self-hosted", "b"], runnerRepo: shared, max: 3 });
    const github = new FakeGitHub([]);
    github.runnersByRepo[shared] = [runner({ id: 1, busy: false, labels: ["self-hosted", "a"] })];
    const h = harness({ pools: [a, b], github, jobs: [] });

    await h.controller.reconcile();
    expect(h.github.runnerCalls).toBe(2);
    expect(github.runnerScopes).toEqual([shared, shared]);
  });

  test("a sustained staffing shortfall is reported as an error", async () => {
    const github = new FakeGitHub(jobsFor([1, 2], ["self-hosted", "runner-default"]), []);
    const { logger, lines } = collectLogger();
    const h = harness({ github, counts: { default: 2 }, logger });

    await h.controller.reconcile();
    expect(lines.some((line) => line.severity === "ERROR")).toBe(false);

    h.clock.advance(6 * 60_000);
    lines.length = 0;
    await h.controller.reconcile();
    expect(lines.find((line) => line.message === "worker pool instances are not becoming runners")).toMatchObject({
      severity: "ERROR",
      pool: "default",
      shortfall: 2,
    });
  });
});

describe("recording an observation", () => {
  test("happens before the scaling write, and its failure fails the pass", async () => {
    // Writing first and recording after loses the record of a busy pool exactly
    // when the store is unhappy, and a lost anchor is a cooldown that never
    // starts.
    const h = harness({ jobs: jobsFor([1], ["self-hosted", "runner-default"]) });
    const broken = {
      get: h.store.get.bind(h.store),
      put: async () => {
        throw new Error("store is unavailable");
      },
    };
    const controller = new Controller({
      pools: [DEFAULT],
      store: broken,
      workerPools: h.workerPools,
      github: h.github,
      clock: h.clock,
      logger: nullLogger,
      minPassIntervalMs: 0,
    });

    await expect(
      controller.handleWorkflowJob(event("queued", ["self-hosted", "runner-default"])),
    ).rejects.toThrow("store is unavailable");
    expect(h.workerPools.writes).toEqual([]);
  });

  test("a pool with steady demand can still shed the instances above it", async () => {
    // The anchor records when every instance was justified, not merely when
    // there was any work: refreshing it on any demand at all left a pool with
    // three jobs and four instances unable to ever drop the fourth.
    const h = harness({ jobs: jobsFor([1, 2, 3], ["self-hosted", "runner-default"]), counts: { default: 4 } });
    await h.controller.reconcile();
    expect(h.workerPools.countOf("default")).toBe(4);

    h.clock.advance(6 * 60_000);
    await h.controller.reconcile();
    expect(h.workerPools.countOf("default")).toBe(3);
  });

  test("a first pass seeds the anchor, so an unknown history is not a licence to scale away", async () => {
    const h = harness({ jobs: [], counts: { default: 3 } });
    await h.controller.reconcile();
    expect(h.workerPools.countOf("default")).toBe(3);
    expect((await h.store.get("default")).state.lastBusyAt).toBe(h.clock.now());
  });
});

describe("repairing an unusable anchor", () => {
  test("a future anchor costs one cooldown, not the pool", async () => {
    // Reproduces the stuck case: with a far-future anchor, every pass used to
    // report another full cooldown remaining, for as long as the value stood.
    const h = harness({ jobs: [], counts: { default: 4 } });
    await h.store.put("default", { lastBusyAt: 1e30, shortfallSince: null }, null);

    await h.controller.reconcile();
    expect(h.workerPools.countOf("default")).toBe(4);
    // The pass rewrote it to something usable.
    expect((await h.store.get("default")).state.lastBusyAt).toBe(h.clock.now());

    h.clock.advance(6 * 60_000);
    await h.controller.reconcile();
    expect(h.workerPools.countOf("default")).toBe(0);
  });
});

describe("the cooldown anchor without the org cross-check", () => {
  const solo = pool({ name: "solo", workerPool: "solo-runner", labels: ["self-hosted", "solo"], cooldownSeconds: 300 });

  test("does not refresh while a job runs on a pool with spare instances", async () => {
    // The README recommends a generous `cooldownSeconds` for exactly this
    // deployment — no `GITHUB_ORG`, so no runner observations, the cooldown
    // carrying the decision alone. It does not do what that suggests. The
    // anchor only restarts when *every* instance was justified, so three
    // instances with one running job never refresh it, and the cooldown has
    // already elapsed by the time the job ends. Asserted here because the
    // README now says so and must keep saying something true.
    const h = harness({
      pools: [solo],
      counts: { solo: 3 },
      jobs: jobsFor([1], ["self-hosted", "solo"], "in_progress"),
    });

    const first = await h.controller.reconcile();
    expect(first.decisions[0]?.outcome).toBe("blocked_in_progress");
    const anchor = (await h.store.get("solo")).state.lastBusyAt;

    // Half an hour of the job running, on a 5-minute cooldown.
    for (let i = 0; i < 6; i++) {
      h.clock.advance(5 * 60_000);
      await h.controller.reconcile();
    }
    expect((await h.store.get("solo")).state.lastBusyAt).toBe(anchor);

    // The job ends. One second later the pool is cut to zero on a cooldown
    // that elapsed twenty-nine minutes ago.
    h.github.jobs = [];
    h.clock.advance(1000);
    const last = await h.controller.reconcile();
    expect(last.decisions[0]?.outcome).toBe("scale_down");
    expect(h.workerPools.countOf("solo")).toBe(0);
  });
});

describe("a pool above its own ceiling", () => {
  const small = pool({ name: "small", workerPool: "small-runner", labels: ["self-hosted", "small"], max: 2 });

  test("waits out the cooldown when no runner has registered", async () => {
    // Something else set the count above `max` — a deploy, a human, or `max`
    // being lowered. Nothing has registered, so there is no runner evidence and
    // the cooldown governs. Note what this does NOT assert: queued demand is
    // not what holds the count up. The next test is the same situation with
    // runners present, and it comes down.
    const h = harness({
      pools: [small],
      counts: { small: 4 },
      jobs: jobsFor([1, 2, 3, 4, 5, 6, 7, 8, 9], ["self-hosted", "small"]),
    });
    const first = await h.controller.reconcile();
    expect(first.decisions[0]?.outcome).toBe("blocked_cooldown");
    expect(h.workerPools.countOf("small")).toBe(4);

    // And it never elapses. `busy` is true on any pass where demand is at
    // least the instance count, so each pass pushes the anchor forward. An
    // hour of passes changes nothing. Asserting only the first pass would
    // leave this documented-as-temporary when it is permanent.
    for (let i = 0; i < 12; i++) {
      h.clock.advance(5 * 60_000);
      const next = await h.controller.reconcile();
      expect(next.decisions[0]?.outcome).toBe("blocked_cooldown");
    }
    expect(h.workerPools.countOf("small")).toBe(4);
  });

  test("is cut back to the ceiling once its runners are seen idle", async () => {
    // Queued demand far above `max` does not keep the surplus alive. The moment
    // GitHub confirms nothing is in progress and the pool's runners are idle,
    // the count drops to `max` — `max` is a ceiling, not a target to grow into.
    // Asserted here because the README states this and the property layer
    // cannot reach it: its external writer is capped at `max`.
    const github = new FakeGitHub(
      jobsFor([1, 2, 3, 4, 5, 6, 7, 8, 9], ["self-hosted", "small"]),
      [1, 2, 3, 4].map((id) =>
        runner({ id, name: `small-runner-${id}`, busy: false, labels: ["self-hosted", "small"] }),
      ),
    );
    const h = harness({ pools: [small], counts: { small: 4 }, github });

    const { decisions } = await h.controller.reconcile();

    expect(decisions[0]?.demand).toBe(9);
    expect(decisions[0]?.desired).toBe(2);
    expect(decisions[0]?.outcome).toBe("scale_down");
    expect(decisions[0]?.idleEvidence).toBe("runners");
    expect(h.workerPools.countOf("small")).toBe(2);
  });

  test("comes down once demand falls below the count", async () => {
    const h = harness({
      pools: [small],
      counts: { small: 4 },
      jobs: jobsFor([1], ["self-hosted", "small"]),
    });
    await h.controller.reconcile();
    h.clock.advance(30 * 60_000);
    await h.controller.reconcile();
    expect(h.workerPools.countOf("small")).toBe(1);
  });
});
