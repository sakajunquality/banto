import type { PoolState } from "./types.ts";
import { emptyPoolState } from "./types.ts";

/**
 * Demand state has to survive a restart and has to be correct when more than
 * one instance is handling webhooks, so it lives outside the process and every
 * write carries the version it was read at. A writer that lost the race is told
 * so and retries on fresh state; it never silently overwrites.
 */

export interface VersionedState {
  state: PoolState;
  /** Opaque version. `null` means "the document does not exist yet". */
  version: string | null;
}

export class ConcurrencyError extends Error {
  constructor(message = "demand state changed under us") {
    super(message);
    this.name = "ConcurrencyError";
  }
}

export interface DemandStore {
  get(key: string): Promise<VersionedState>;
  /** Writes only if the stored version still equals `expectedVersion`. */
  put(key: string, state: PoolState, expectedVersion: string | null): Promise<VersionedState>;
}

export interface MutateOptions {
  attempts?: number;
  /** Injected so tests do not wait; defaults to a jittered backoff. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function backoff(attempt: number, random: () => number): number {
  return Math.floor(2 ** attempt * 25 * (0.5 + random()));
}

/**
 * Read, transform, write, retrying the whole cycle when another writer got
 * there first. The transform must be pure: it is run again on each attempt.
 *
 * Retries back off with jitter: several instances racing on the same pool would
 * otherwise retry in lockstep and keep colliding.
 */
export async function mutate(
  store: DemandStore,
  key: string,
  fn: (state: PoolState) => PoolState,
  options: MutateOptions = {},
): Promise<PoolState> {
  const attempts = options.attempts ?? 5;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const current = await store.get(key);
    const next = fn(current.state);
    try {
      const written = await store.put(key, next, current.version);
      return written.state;
    } catch (error) {
      if (!(error instanceof ConcurrencyError)) throw error;
      lastError = error;
      if (i < attempts - 1) await sleep(backoff(i, random));
    }
  }
  throw lastError instanceof Error ? lastError : new ConcurrencyError();
}

/** In-memory store: single instance and tests. Not for a multi-instance deploy. */
export class MemoryDemandStore implements DemandStore {
  private readonly docs = new Map<string, { state: PoolState; version: string }>();
  private counter = 0;

  async get(key: string): Promise<VersionedState> {
    const doc = this.docs.get(key);
    if (!doc) return { state: emptyPoolState(), version: null };
    return { state: structuredClone(doc.state), version: doc.version };
  }

  async put(key: string, state: PoolState, expectedVersion: string | null): Promise<VersionedState> {
    const doc = this.docs.get(key);
    const actual = doc?.version ?? null;
    if (actual !== expectedVersion) {
      throw new ConcurrencyError(
        `version mismatch for ${key}: expected ${expectedVersion ?? "<absent>"}, found ${actual ?? "<absent>"}`,
      );
    }
    const version = `v${++this.counter}`;
    this.docs.set(key, { state: structuredClone(state), version });
    return { state: structuredClone(state), version };
  }
}
