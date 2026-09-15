import type { ExecutionState, RunnerLaunch } from "./types.ts";

export const emptyExecutionState = (): ExecutionState => ({ launches: [], failures: 0, retryAfter: 0 });

/** Losing a launch reservation can duplicate a paid execution. Reject corruption. */
export function readExecutionState(value: unknown): ExecutionState {
  const fail = (): never => { throw new Error("invalid execution launch state; refusing to forget reservations"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const state = value as Record<string, unknown>;
  if (!Array.isArray(state.launches) || !nonNegative(state.failures) || !nonNegative(state.retryAfter)) return fail();
  const ids = new Set<string>();
  const launches: RunnerLaunch[] = state.launches.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") return fail();
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !/^[a-f0-9-]{36}$/.test(raw.id) || ids.has(raw.id)) return fail();
    if (!nonNegative(raw.createdAt)) return fail();
    if (raw.runnerId !== undefined && (!nonNegative(raw.runnerId) || raw.runnerId === 0)) return fail();
    if (raw.notSubmitted !== undefined && typeof raw.notSubmitted !== "boolean") return fail();
    if (raw.notSubmitted && (raw.operation !== undefined || raw.execution !== undefined)) return fail();
    for (const field of ["operation", "execution"] as const) {
      if (raw[field] !== undefined && (typeof raw[field] !== "string" || !/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/(?:jobs\/[a-z0-9-]+\/executions|operations)\/[a-zA-Z0-9_-]+$/.test(raw[field]))) return fail();
    }
    ids.add(raw.id);
    return {
      id: raw.id, createdAt: raw.createdAt as number,
      ...(raw.runnerId === undefined ? {} : { runnerId: raw.runnerId as number }),
      ...(raw.notSubmitted === undefined ? {} : { notSubmitted: raw.notSubmitted as boolean }),
      ...(raw.operation === undefined ? {} : { operation: raw.operation as string }),
      ...(raw.execution === undefined ? {} : { execution: raw.execution as string }),
    };
  });
  return { launches, failures: state.failures as number, retryAfter: state.retryAfter as number };
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
