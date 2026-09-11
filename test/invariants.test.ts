import { describe, expect, test } from "bun:test";
import type { WorkerPoolClient, WorkerPoolState } from "../src/cloudrun.ts";
import { Controller } from "../src/controller.ts";
import type { GitHubClient, Listing, RateLimitState, RunnerListing } from "../src/github.ts";
import { createLogger, nullLogger } from "../src/log.ts";
import { ConcurrencyError, type DemandStore, MemoryDemandStore, type VersionedState } from "../src/store.ts";
import type { ObservedJob, ObservedRunner, PoolConfig, PoolState } from "../src/types.ts";
import { pool } from "./helpers.ts";

/**
 * A property test over random interleavings, written against the conditions
 * that expose the bugs this service has actually had.
 *
 * The first version of this file asserted the right invariants against a world
 * too tame to violate them: the clock never moved, so the cooldown blocked
 * every lowering whether or not the evidence behind it was stale; there were no
 * runners, so the idle-runner path was never taken; nothing ever failed, so
 * partial evidence never arose; and one controller against a never-failing
 * store could not reproduce anything from the multi-writer rounds. It passed
 * with three separate historical bugs reintroduced, which makes it worse than
 * no test: it was evidence of nothing, presented as evidence of something.
 *
 * What the model now includes, each item because a past bug needed it:
 *
 *  - the clock advances during the phase where lowering must not happen, so the
 *    cooldown is not silently doing the work an invariant claims to check;
 *  - runners exist, are sometimes idle (making a lowering *easy* to authorise,
 *    which is what a stale observation would exploit) and sometimes busy;
 *  - listings fail and come back partial;
 *  - store writes fail;
 *  - two controllers share one store and one world;
 *  - worker pools are keyed by their **physical** identity, so two logical
 *    pools pointing at one worker pool would show up as interference.
 *
 * Which historical bugs each invariant catches is recorded in `docs/property-test.md`,
 * along with the classes it still cannot reach.
 */

const POOLS: PoolConfig[] = [
  pool({
    name: "default",
    workerPool: "default-runner",
    labels: ["self-hosted", "runner-default"],
    max: 6,
    cooldownSeconds: 300,
  }),
  pool({
    name: "build",
    workerPool: "build-runner",
    labels: ["self-hosted", "runner-build"],
    max: 6,
    cooldownSeconds: 300,
  }),
];

/** Deterministic PRNG, so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let state = (seed * 2_654_435_761) >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

interface Observation {
  controller: string;
  tick: number;
  kind: "jobs" | "runners";
  /** Null when the call failed: the pass looked and came back with nothing. */
  demandByPool: Map<string, number> | null;
  busyByPool: Map<string, number> | null;
  complete: boolean;
}

interface WriteRecord {
  controller: string;
  target: string;
  from: number;
  to: number;
  /** What the world justified for that pool at the moment of the write. */
  worldDemand: number;
  worldBusyRunners: number;
  /** Logical time of the write. */
  tick: number;
}

/** The world the fakes read: what GitHub would say, and what Cloud Run holds. */
class World {
  jobs: ObservedJob[] = [];
  runners: ObservedRunner[] = [];
  /** Keyed by physical identity, as Cloud Run is — not by banto's pool name. */
  counts = new Map<string, number>();
  etags = new Map<string, string>();
  /** Writes the API refused because the caller held a stale etag. */
  rejectedWrites = 0;
  /** Writes that carried no precondition at all, which the API would accept. */
  unconditionalWrites = 0;
  /** Changes made by something other than banto — a deploy, a human, gcloud. */
  externalWrites = 0;
  writes: WriteRecord[] = [];
  /** Logical clock over observations and writes, for ordering them. */
  tick = 0;
  /**
   * Every listing a controller *received*, with what it said. The freshness
   * invariant compares a decision against these: recording that a call was
   * attempted is not enough, because a cached listing reused after a failed
   * refresh is a call attempted and evidence not gathered.
   */
  observations: Observation[] = [];
  /** Decision lines, in order, tagged with the controller that emitted them. */
  decisions: { controller: string; fields: Record<string, unknown>; tick: number }[] = [];
  /** Whether something else writes the pool between a read and a write. */
  externalWriterEnabled = false;
  reads = 0;
  /** Injected failures, as a probability per call. */
  jobFailureRate = 0;
  partialRate = 0;
  runnerFailureRate = 0;
  storeFailureRate = 0;
  /**
   * A writer with a badly skewed clock, which is where an unusable anchor comes
   * from in the wild: the value it stores is in the future, and a future anchor
   * never elapses.
   */
  skewedWriterRate = 0;

  demandFor(target: PoolConfig): number {
    return this.jobs.filter((job) => target.labels.every((label) => job.labels.includes(label))).length;
  }

  busyRunnersFor(target: PoolConfig): number {
    return this.runners.filter((r) => r.busy && target.labels.every((label) => r.labels.includes(label))).length;
  }
}

function physical(target: PoolConfig): string {
  return `${target.project}/${target.location}/${target.workerPool}`;
}

/** Yields control a random number of times, so call orderings vary by seed. */
async function jitter(random: () => number): Promise<void> {
  const ticks = Math.floor(random() * 4);
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

class WorldGitHub implements GitHubClient {
  constructor(
    private readonly world: World,
    private readonly random: () => number,
    private readonly controller: string,
  ) {}

  async observeJobs(): Promise<Listing<ObservedJob>> {
    await jitter(this.random);
    if (this.random() < this.world.jobFailureRate) {
      this.record("jobs", null, false);
      throw new Error("GitHub job listing failed");
    }
    const all = [...this.world.jobs];
    await jitter(this.random);
    // A partial listing reports fewer rows than exist, which is what a
    // truncated page looks like from the outside.
    const partial = this.random() < this.world.partialRate;
    const items = partial ? all.slice(0, Math.floor(all.length / 2)) : all;
    this.record("jobs", items, !partial);
    return { items, complete: !partial };
  }

  async observeRunners(): Promise<RunnerListing> {
    await jitter(this.random);
    if (this.random() < this.world.runnerFailureRate) {
      this.record("runners", null, false);
      throw new Error("GitHub runner listing failed");
    }
    const all = [...this.world.runners];
    const partial = this.random() < this.world.partialRate;
    const items = partial ? all.filter((r) => !r.busy) : all;
    this.record("runners", items, !partial);
    return { configured: true, items, complete: !partial };
  }

  /** What this listing said about each pool, as the controller will read it. */
  private record(kind: "jobs" | "runners", items: ObservedJob[] | ObservedRunner[] | null, complete: boolean): void {
    let demandByPool: Map<string, number> | null = null;
    let busyByPool: Map<string, number> | null = null;
    if (items !== null && kind === "jobs") {
      demandByPool = new Map();
      for (const target of POOLS) {
        const jobs = items as ObservedJob[];
        demandByPool.set(target.name, jobs.filter((j) => target.labels.every((l) => j.labels.includes(l))).length);
      }
    }
    if (items !== null && kind === "runners") {
      busyByPool = new Map();
      for (const target of POOLS) {
        const runners = items as ObservedRunner[];
        busyByPool.set(
          target.name,
          runners.filter((r) => r.busy && target.labels.every((l) => r.labels.includes(l))).length,
        );
      }
    }
    this.world.observations.push({
      controller: this.controller,
      tick: this.world.tick++,
      kind,
      demandByPool,
      busyByPool,
      complete,
    });
  }

  rateLimit(): RateLimitState | null {
    return null;
  }
}

/**
 * Cloud Run, with the part that matters modelled: the etag is a precondition.
 *
 * A fake that always accepts a write cannot tell you whether the code still
 * sends the precondition — dropping it would be invisible — so this one issues
 * a fresh etag on every write and rejects a stale one, as the API does.
 */
class WorldWorkerPools implements WorkerPoolClient {
  constructor(
    private readonly world: World,
    private readonly random: () => number,
    private readonly controller: string,
  ) {}

  async get(target: PoolConfig): Promise<WorkerPoolState> {
    await jitter(this.random);
    const key = physical(target);
    const state = { instanceCount: this.world.counts.get(key) ?? 0, etag: this.world.etags.get(key) ?? "etag-0" };
    // Something else touches the pool between banto's read and its write: a
    // deploy, a human with gcloud, Terraform. This is the situation the etag
    // precondition exists for, and without it in the model a missing
    // precondition has nothing to clobber and cannot be measured.
    // Every fifth read rather than a random draw: this is a guard the test
    // asserts on, so it has to fire on every seed rather than on most of them.
    if (this.world.externalWriterEnabled && ++this.world.reads % 5 === 0) {
      // Kept inside the pool's configured range. Above `max` is a state banto
      // deliberately will not correct while queued demand exceeds `max` —
      // cutting capacity under work that could start at any moment is the
      // hazard the cooldown exists for — so it is a documented limitation
      // rather than a convergence failure, and the model does not create it.
      const next = Math.min((this.world.counts.get(key) ?? 0) + 1, target.max);
      if (next !== (this.world.counts.get(key) ?? 0)) {
        this.world.counts.set(key, next);
        this.world.etags.set(key, `etag-external-${this.world.tick++}`);
        this.world.externalWrites++;
      }
    }
    return state;
  }

  async setInstanceCount(target: PoolConfig, count: number, etag: string): Promise<void> {
    await jitter(this.random);
    const key = physical(target);
    const current = this.world.etags.get(key) ?? "etag-0";
    // An empty etag is no precondition, which is how the API reads it: the
    // write is unconditional and succeeds. A *stale* etag is a conflict and is
    // refused. Modelling both is what lets a mutation distinguish "dropped the
    // precondition" from "sent the wrong one".
    if (etag === "") this.world.unconditionalWrites++;
    if (etag !== "" && etag !== current) {
      this.world.rejectedWrites++;
      throw new Error("Cloud Run precondition failed: stale etag");
    }
    const from = this.world.counts.get(key) ?? 0;
    this.world.counts.set(key, count);
    this.world.etags.set(key, `etag-${this.world.tick}`);
    this.world.writes.push({
      controller: this.controller,
      target: key,
      from,
      to: count,
      worldDemand: this.world.demandFor(target),
      worldBusyRunners: this.world.busyRunnersFor(target),
      tick: this.world.tick++,
    });
  }
}

/** A store that fails writes at a configured rate, shared by both controllers. */
class FlakyStore implements DemandStore {
  constructor(
    private readonly inner: MemoryDemandStore,
    private readonly world: World,
    private readonly random: () => number,
  ) {}

  async get(key: string): Promise<VersionedState> {
    await jitter(this.random);
    return this.inner.get(key);
  }

  async put(key: string, state: PoolState, expectedVersion: string | null): Promise<VersionedState> {
    await jitter(this.random);
    if (this.random() < this.world.storeFailureRate) throw new Error("store write failed");
    if (this.random() < this.world.skewedWriterRate && state.lastBusyAt) {
      return this.inner.put(key, { ...state, lastBusyAt: state.lastBusyAt + 86_400_000 }, expectedVersion);
    }
    return this.inner.put(key, state, expectedVersion);
  }
}

/**
 * Build controllers over a shared world and store.
 *
 * `poolsPer` decides whether each controller serves every pool or exactly one.
 * One pool per controller is what lets a test pair a write with the fetch that
 * produced it: passes for a pool are serialised inside a controller, so with a
 * single pool each controller's fetches and writes strictly alternate.
 */
function scenario(seed: number, assignments: PoolConfig[][]) {
  const random = rng(seed);
  const world = new World();
  const inner = new MemoryDemandStore();
  const store = new FlakyStore(inner, world, random);
  const clock = {
    value: 1_700_000_000_000,
    now() {
      return this.value;
    },
  };
  const made = assignments.map((pools, index) => {
    const name = `c${index}`;
    // The decision line is emitted right after the write, inside the same
    // serialised pass, so it names the evidence that write was made from.
    const logger = createLogger("INFO", (line) => {
      const fields = JSON.parse(line) as Record<string, unknown>;
      if (fields.message === "scaling decision") {
        world.decisions.push({ controller: name, fields, tick: world.tick++ });
      }
    });
    return new Controller({
      pools,
      store,
      workerPools: new WorldWorkerPools(world, random, name),
      github: new WorldGitHub(world, random, name),
      clock,
      logger,
      minPassIntervalMs: 0,
      // Deterministic retries: the default backoff uses real timers and
      // Math.random, which would make these interleavings irreproducible.
      retry: { sleep: async () => {}, random: () => 0.5 },
    });
  });
  return { random, world, clock, controllers: made };
}

function trigger(controller: Controller, target: PoolConfig): Promise<unknown> {
  return controller.handleWorkflowJob({ action: "queued", workflow_job: { id: 1, labels: target.labels } });
}

/** Swallow the failures the model injects on purpose. */
function settle(work: Promise<unknown>[]): Promise<unknown> {
  return Promise.all(work.map((p) => p.catch(() => undefined)));
}

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34];
/** The freshness property is the cheapest and the most load-bearing, so it runs wider. */
const FRESHNESS_SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597];

describe("no decision acts on evidence that a later write has already contradicted", () => {
  for (const seed of FRESHNESS_SEEDS) {
    test(`seed ${seed}`, async () => {
      // The stale-evidence class, stated soundly.
      //
      // A pass may legitimately write a count that is already out of date: its
      // evidence was a moment old, and banto promises convergence rather than
      // per-write correctness. What it may never do is *lower* a count using
      // evidence gathered before a write that has since landed — that is
      // evidence which was already known to be superseded, and it is exactly
      // what a pre-gathered listing or a queued closure produces.
      //
      // Each controller serves one pool so that its fetches and writes pair up:
      // passes for a pool are serialised, so a controller's most recent fetch
      // before a write is that pass's own evidence.
      const { random, world, clock, controllers } = scenario(seed, [[POOLS[0] as PoolConfig], [POOLS[0] as PoolConfig], [POOLS[1] as PoolConfig]]);
      world.partialRate = 0.2;
      world.jobFailureRate = 0.35;
      world.runnerFailureRate = 0.2;
      world.storeFailureRate = 0.1;
      // Idle runners throughout, so the runner path makes a lowering as easy as
      // possible to authorise: the invariant is then about freshness alone.
      for (const [index, target] of POOLS.entries()) {
        world.runners.push({ id: 1000 + index, name: "r", busy: false, status: "online", labels: target.labels });
      }

      const inFlight: Promise<unknown>[] = [];
      for (let step = 0; step < 30; step++) {
        const choice = random() < 0.5 ? 0 : 1;
        const target = POOLS[choice] as PoolConfig;
        world.jobs.push({ id: step + 1, status: random() < 0.3 ? "in_progress" : "queued", labels: target.labels });
        // Past the cooldown regularly, so the cooldown is not quietly doing the
        // blocking that this invariant claims to be checking.
        clock.value += Math.floor(random() * 400_000);
        const controller = controllers[Math.floor(random() * controllers.length)] as Controller;
        if (random() < 0.8) inFlight.push(trigger(controller, target));
        if (random() < 0.3) inFlight.push(controller.reconcile());
        await jitter(random);
      }
      await settle(inFlight);

      // Pair every write with the decision line that follows it — same pass,
      // same serialised sequence — and check that what the decision *consumed*
      // is exactly what the last listing handed that controller before it said.
      //
      // "The last listing before the decision" rather than "some listing since
      // the previous write": a pass fetches once, so its own listing is the
      // last one before its decision line. An earlier window let a stale
      // listing from a previous non-writing pass stand in for the one this
      // pass should have gathered, and the injected cache defect passed.
      const violations: unknown[] = [];
      for (const write of world.writes) {
        const decision = world.decisions.find((d) => d.controller === write.controller && d.tick > write.tick);
        if (!decision) {
          violations.push({ ...write, why: "no decision line followed this write" });
          continue;
        }
        const pool = String(decision.fields.pool);
        const demand = Number(decision.fields.demand);
        const complete = decision.fields.evidence === "complete";
        const busy = decision.fields.runnersBusy;

        // Bounded to this pass. Every pass ends with exactly one decision line,
        // so the observations belonging to this one are those after the
        // previous decision by the same controller. Without the lower bound the
        // search falls back on an earlier pass's listing, and a controller that
        // caches evidence and never refreshes satisfies it — which is to say,
        // the invariant would assume the very thing it is meant to establish.
        const previousDecision = [...world.decisions]
          .reverse()
          .find((d) => d.controller === write.controller && d.tick < write.tick);
        const passStart = previousDecision?.tick ?? -1;
        const mine = world.observations.filter(
          (o) => o.controller === write.controller && o.tick > passStart && o.tick < decision.tick,
        );
        const jobsObs = [...mine].reverse().find((o) => o.kind === "jobs");
        const runnersObs = [...mine].reverse().find((o) => o.kind === "runners");

        const jobsMatch =
          jobsObs !== undefined &&
          (jobsObs.demandByPool === null
            ? demand === 0 && !complete
            : jobsObs.demandByPool.get(pool) === demand &&
              // Completeness is checked one way only: a decision may be partial
              // because the *runner* listing was, while its demand came from a
              // complete job listing. It may never be complete when the job
              // listing was not.
              (!complete || jobsObs.complete));
        const runnersMatch = busy === undefined || (runnersObs?.busyByPool?.get(pool) ?? null) === Number(busy);

        if (!jobsMatch || !runnersMatch) {
          violations.push({
            ...write,
            why: !jobsMatch
              ? jobsObs === undefined
                ? "this pass decided without looking at all"
                : "the demand this decision used is not what it was handed"
              : "the runner view this decision used is not what it was handed",
            consumed: { pool, demand, complete, busy },
            handed: {
              demand: jobsObs?.demandByPool?.get(pool) ?? null,
              complete: jobsObs?.complete ?? null,
              busy: runnersObs?.busyByPool?.get(pool) ?? null,
            },
          });
        }
      }
      expect({ seed, violations }).toEqual({ seed, violations: [] });
    });
  }
});

describe("no write lowers a count while a runner for that pool is busy", () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}`, async () => {
      // Busy from the start and busy throughout, so there is no window in which
      // a fresh observation could have justified a lowering. A pass either sees
      // the busy runner (and is blocked) or cannot see the listing (and is
      // blocked as partial evidence); nothing else is correct.
      const { random, world, clock, controllers } = scenario(seed, [POOLS, POOLS]);
      world.partialRate = 0.3;
      world.runnerFailureRate = 0.3;
      world.jobFailureRate = 0.1;
      world.storeFailureRate = 0.1;
      for (const [index, target] of POOLS.entries()) {
        world.runners.push({ id: 500 + index, name: "busy", busy: true, status: "online", labels: target.labels });
        world.counts.set(physical(target), 3);
      }

      const inFlight: Promise<unknown>[] = [];
      for (let step = 0; step < 25; step++) {
        const target = POOLS[random() < 0.5 ? 0 : 1] as PoolConfig;
        // Demand drains away while the runners stay busy: the tempting case.
        if (world.jobs.length > 0 && random() < 0.6) world.jobs.pop();
        clock.value += Math.floor(random() * 600_000);
        const controller = controllers[Math.floor(random() * controllers.length)] as Controller;
        if (random() < 0.8) inFlight.push(trigger(controller, target));
        if (random() < 0.4) inFlight.push(controller.reconcile());
        await jitter(random);
      }
      await settle(inFlight);

      const lowering = world.writes.filter((write) => write.to < write.from && write.worldBusyRunners > 0);
      expect({ seed, lowering }).toEqual({ seed, lowering: [] });
    });
  }
});

describe("the count converges once the world stops changing", () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}`, async () => {
      const { random, world, clock, controllers } = scenario(seed, [POOLS, POOLS]);
      world.partialRate = 0.2;
      world.jobFailureRate = 0.15;
      world.runnerFailureRate = 0.15;
      world.storeFailureRate = 0.15;
      world.skewedWriterRate = 0.2;
      world.externalWriterEnabled = true;

      const inFlight: Promise<unknown>[] = [];
      for (let step = 0; step < 25; step++) {
        const target = POOLS[random() < 0.5 ? 0 : 1] as PoolConfig;
        if (random() < 0.6) {
          world.jobs.push({ id: step + 1, status: "queued", labels: target.labels });
        } else if (world.jobs.length > 0) {
          world.jobs.splice(Math.floor(random() * world.jobs.length), 1);
        }
        clock.value += Math.floor(random() * 60_000);
        const controller = controllers[Math.floor(random() * controllers.length)] as Controller;
        if (random() < 0.8) inFlight.push(trigger(controller, target));
        if (random() < 0.3) inFlight.push(controller.reconcile());
        await jitter(random);
      }
      await settle(inFlight);

      // The world stops moving and the failures stop: banto must reach the
      // right answer from wherever the chaos left it.
      world.partialRate = 0;
      world.jobFailureRate = 0;
      world.runnerFailureRate = 0;
      world.storeFailureRate = 0;
      world.skewedWriterRate = 0;
      world.externalWriterEnabled = false;
      const first = controllers[0] as Controller;
      await first.reconcile();
      clock.value += 10 * 60_000;
      await first.reconcile();
      clock.value += 10 * 60_000;
      await first.reconcile();

      for (const target of POOLS) {
        const expected = Math.min(world.demandFor(target), target.max);
        expect({ seed, pool: target.name, count: world.counts.get(physical(target)) ?? 0 }).toEqual({
          seed,
          pool: target.name,
          count: expected,
        });
      }

      // Every write carried a precondition. Without one, a write lands on top
      // of whatever the deploy or the human just did, silently.
      expect({ seed, unconditional: world.unconditionalWrites }).toEqual({ seed, unconditional: 0 });
      // And the precondition was actually exercised, so the assertion above is
      // not passing for want of anything to collide with.
      expect(world.externalWrites).toBeGreaterThan(0);
    });
  }
});

describe("every write is a count the configuration allows", () => {
  for (const seed of [1, 8, 21]) {
    test(`seed ${seed}`, async () => {
      const { random, world, clock, controllers } = scenario(seed, [POOLS, POOLS]);
      world.partialRate = 0.3;
      world.jobFailureRate = 0.2;
      world.runnerFailureRate = 0.2;
      world.storeFailureRate = 0.2;

      const inFlight: Promise<unknown>[] = [];
      for (let step = 0; step < 20; step++) {
        const target = POOLS[random() < 0.5 ? 0 : 1] as PoolConfig;
        world.jobs.push({ id: step, status: "queued", labels: target.labels });
        clock.value += Math.floor(random() * 30_000);
        const controller = controllers[Math.floor(random() * controllers.length)] as Controller;
        inFlight.push(trigger(controller, target));
        await jitter(random);
      }
      await settle(inFlight);

      for (const write of world.writes) {
        const target = POOLS.find((p) => physical(p) === write.target) as PoolConfig;
        expect({ seed, ok: write.to >= target.min && write.to <= target.max }).toEqual({ seed, ok: true });
      }
    });
  }
});

describe("banto recovers from state it cannot trust", () => {
  test("a cooldown anchor written by a skewed clock does not pin a pool open", async () => {
    // Randomised skew injection turned out not to reach this reliably — the
    // draw has to coincide with a pool that needs lowering — so the recovery
    // property gets a deterministic case of its own.
    const { world, clock, controllers } = scenario(99, [POOLS]);
    const controller = controllers[0] as Controller;
    for (const target of POOLS) world.counts.set(physical(target), 3);

    await controller.reconcile();
    // A writer a day ahead of everyone else stamps the anchor.
    for (const target of POOLS) {
      const current = await (controller as unknown as { deps: { store: DemandStore } }).deps.store.get(target.name);
      await (controller as unknown as { deps: { store: DemandStore } }).deps.store.put(
        target.name,
        { lastBusyAt: clock.value + 86_400_000, shortfallSince: null },
        current.version,
      );
    }

    clock.value += 10 * 60_000;
    await controller.reconcile();
    clock.value += 10 * 60_000;
    await controller.reconcile();

    for (const target of POOLS) {
      expect({ pool: target.name, count: world.counts.get(physical(target)) ?? 0 }).toEqual({
        pool: target.name,
        count: 0,
      });
    }
  });
});
