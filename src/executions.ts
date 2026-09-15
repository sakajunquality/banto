import { randomUUID } from "node:crypto";
import { LaunchNotSubmitted, type RunnerExecution, type RunnerExecutionClient } from "./cloudrun-jobs.ts";
import { clamp, type Decision } from "./decide.ts";
import type { RunnerRegistrar } from "./github.ts";
import { HttpError } from "./http.ts";
import { emptyExecutionState } from "./launch-state.ts";
import type { Logger } from "./log.ts";
import { mutate, type DemandStore, type MutateOptions } from "./store.ts";
import type { Clock, ExecutionState, PoolConfig, PoolEvidence, RunnerLaunch } from "./types.ts";

export const MAX_STARTS_PER_PASS = 10;

export interface ExecutionScalerDeps {
  store: DemandStore;
  client: RunnerExecutionClient;
  registrar: RunnerRegistrar;
  clock: Clock;
  logger: Logger;
  retry?: MutateOptions;
}

/** Durable reservations bound cost without storing or replaying GitHub jobs. */
export class ExecutionScaler {
  constructor(private readonly deps: ExecutionScalerDeps) {}

  async reconcile(pool: PoolConfig, evidence: PoolEvidence): Promise<Decision> {
    let state = (await this.deps.store.get(pool.name)).state.executions ?? emptyExecutionState();
    const unidentified = state.launches.filter((launch) => !launch.notSubmitted && !launch.execution && !launch.operation);
    const discovered = unidentified.length ? await this.deps.client.find(pool, unidentified.map((l) => l.id)) : [];
    const retired: { launch: RunnerLaunch; failed: boolean }[] = [];
    const updates = new Map<string, string>();
    for (const launch of state.launches) {
      if (launch.notSubmitted) {
        if (launch.runnerId) await this.deps.registrar.removeRunner(pool, launch.runnerId);
        retired.push({ launch, failed: true });
        continue;
      }
      const execution: RunnerExecution | null = discovered.find((e) => e.launchId === launch.id) ??
        (launch.execution || launch.operation ? await this.deps.client.observe(pool, launch) : null);
      if (!execution) {
        if (this.deps.clock.now() - launch.createdAt >= 120_000) {
          this.deps.logger.warn("launch outcome unknown; reservation retained without replay", { pool: pool.name, launch: launch.id });
        }
        continue;
      }
      if (execution.launchId !== launch.id) throw new Error("execution does not match its launch reservation");
      if (!execution.terminal) {
        if (launch.execution !== execution.name) updates.set(launch.id, execution.name);
        continue;
      }
      // Cleanup only after the independently addressed execution is terminal.
      // A busy observation or a missing heartbeat never reaches this endpoint.
      if (launch.runnerId) await this.deps.registrar.removeRunner(pool, launch.runnerId);
      retired.push({ launch, failed: execution.failed });
    }
    if (retired.length || updates.size) {
      const ids = new Set(retired.map((r) => r.launch.id));
      const failed = retired.some((r) => r.failed);
      const at = this.deps.clock.now();
      state = await this.update(pool, (current) => {
        const failures = failed ? Math.min(current.failures + 1, 10) : retired.length ? 0 : current.failures;
        return {
          launches: current.launches.filter((l) => !ids.has(l.id)).map((l) =>
            updates.has(l.id) ? { ...l, execution: updates.get(l.id)! } : l),
          failures,
          retryAfter: failed ? at + backoff(failures) : retired.length ? 0 : current.retryAfter,
        };
      });
    }
    const current = state.launches.length;
    const desired = clamp(evidence.demand, 0, pool.max);
    let started = 0;
    const blocked = state.retryAfter > this.deps.clock.now();
    if (!blocked) {
      const wanted = Math.min(Math.max(0, desired - current), MAX_STARTS_PER_PASS);
      for (let i = 0; i < wanted; i++) {
        const launch: RunnerLaunch = { id: randomUUID(), createdAt: this.deps.clock.now() };
        state = await this.update(pool, (latest) => latest.launches.length >= desired ? latest :
          { ...latest, launches: [...latest.launches, launch] });
        if (!state.launches.some((l) => l.id === launch.id)) break;
        await this.start(pool, launch);
        started++;
      }
    }
    const target = (await this.deps.store.get(pool.name)).state.executions?.launches.length ?? current;
    const decision: Decision = {
      pool: pool.name, demand: evidence.demand, current, desired, target,
      outcome: started ? "scale_up" : blocked ? "blocked_launch_backoff" : target > desired ? "awaiting_completion" : "unchanged",
      write: started > 0, evidenceComplete: evidence.kind === "complete",
    };
    this.deps.logger.info("scaling decision", { ...decision, backend: "jobs", started, retired: retired.length,
      reservations: target, retryAfter: state.retryAfter, evidence: evidence.kind });
    return decision;
  }

  private async start(pool: PoolConfig, launch: RunnerLaunch): Promise<void> {
    let jit: { runnerId: number; config: string } | undefined;
    try {
      jit = await this.deps.registrar.createJitRunner(pool, `banto-${launch.id}`);
      await this.update(pool, (state) => ({ ...state,
        launches: state.launches.map((l) => l.id === launch.id ? { ...l, runnerId: jit!.runnerId } : l),
      }));
    } catch (error) {
      await this.reject(pool, launch.id, jit?.runnerId);
      throw error;
    }
    let result: { operation: string; execution?: string };
    try {
      result = await this.deps.client.start(pool, launch, jit.config);
    } catch (error) {
      if (error instanceof LaunchNotSubmitted || error instanceof HttpError && [400, 401, 403, 404, 409, 412, 422, 429].includes(error.status)) {
        await this.reject(pool, launch.id, jit.runnerId);
      }
      // Transport failures and 5xx may have accepted the POST. Keep its slot,
      // discover by launch id later, and never mint another execution for it.
      throw error;
    }
    await this.update(pool, (state) => ({ ...state,
      launches: state.launches.map((l) => l.id === launch.id ? { ...l, ...result } : l),
    }));
  }

  private async reject(pool: PoolConfig, id: string, runnerId?: number) {
    // Persist positive rejection before cleanup: a failed DELETE must be
    // retried as cleanup, not mistaken for an ambiguous execution forever.
    await this.update(pool, (state) => ({ ...state,
      launches: state.launches.map((l) => l.id === id ? { ...l, notSubmitted: true,
        ...(runnerId === undefined ? {} : { runnerId }) } : l),
    }));
    if (runnerId) await this.deps.registrar.removeRunner(pool, runnerId);
    const at = this.deps.clock.now();
    await this.update(pool, (state) => {
      const failures = Math.min(state.failures + 1, 10);
      return { launches: state.launches.filter((l) => l.id !== id), failures,
        retryAfter: at + backoff(failures) };
    });
  }

  private async update(pool: PoolConfig, fn: (state: ExecutionState) => ExecutionState): Promise<ExecutionState> {
    const result = await mutate(this.deps.store, pool.name, (state) => ({ ...state,
      executions: fn(state.executions ?? emptyExecutionState()),
    }), this.deps.retry ?? {});
    return result.executions!;
  }
}

function backoff(failures: number): number {
  return Math.min(30_000 * 2 ** (failures - 1), 15 * 60_000);
}
