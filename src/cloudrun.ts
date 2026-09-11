import { expectJson, HttpError, httpRequest } from "./http.ts";
import type { TokenSource } from "./google-auth.ts";
import type { Fetcher, PoolConfig } from "./types.ts";
import { poolResourceName } from "./types.ts";

/**
 * The only two Cloud Run calls banto makes, against the Admin REST API v2:
 *
 *   GET   /v2/{name}                      -> read scaling.manualInstanceCount
 *   PATCH /v2/{name}?updateMask=scaling   -> write it
 *
 * `scaling.scalingMode` is not part of the GA v2 WorkerPoolScaling message, so
 * the PATCH body carries `manualInstanceCount` only; the pool is created in
 * MANUAL mode by Terraform and stays there. The resource's `etag` is sent back
 * to make the update conditional: if someone else (a deploy, another banto
 * instance) moved the pool between our read and our write, the write fails
 * rather than clobbering them, and the next event or reconcile retries.
 *
 * The regional endpoint (`{location}-run.googleapis.com`) is the one Google
 * recommends for v2; it also keeps the call in-region.
 */

export interface WorkerPoolState {
  instanceCount: number;
  etag: string;
}

export interface WorkerPoolClient {
  get(pool: PoolConfig): Promise<WorkerPoolState>;
  setInstanceCount(pool: PoolConfig, count: number, etag: string): Promise<void>;
}

/** The Operation a PATCH returns; a long-running update reports failure in it. */
interface Operation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
}

export class CloudRunWorkerPoolClient implements WorkerPoolClient {
  constructor(
    private readonly tokens: TokenSource,
    private readonly fetchImpl: Fetcher = fetch,
    private readonly timeoutMs?: number,
  ) {}

  async get(pool: PoolConfig): Promise<WorkerPoolState> {
    const what = `GET worker pool ${pool.workerPool}`;
    const response = await httpRequest(
      this.fetchImpl,
      this.url(pool),
      { headers: { authorization: `Bearer ${await this.tokens.token()}`, accept: "application/json" } },
      what,
      this.timeoutMs,
    );
    const body = expectJson<{ scaling?: { manualInstanceCount?: unknown }; etag?: string }>(response, what);

    // No etag means no conditional write, and an unconditional write can undo
    // someone else's change. Refuse the read rather than downgrade the write.
    if (typeof body.etag !== "string" || body.etag === "") {
      throw new Error(`${what} returned no etag; refusing to scale without a precondition`);
    }
    // `expectJson` is a cast, not a check, so this is the only thing standing
    // between an upstream response and the number every decision is made
    // against. Absent means zero: Cloud Run omits zero-valued integers in JSON.
    // Anything else present must be a non-negative integer — an unreadable
    // count is refused the same way a missing etag is, rather than being
    // carried into a decision and then into the logs.
    const raw = body.scaling?.manualInstanceCount ?? 0;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      throw new Error(`${what} returned an unreadable instance count; refusing to scale against it`);
    }
    return { instanceCount: raw, etag: body.etag };
  }

  async setInstanceCount(pool: PoolConfig, count: number, etag: string): Promise<void> {
    const what = `PATCH worker pool ${pool.workerPool}`;
    const response = await httpRequest(
      this.fetchImpl,
      `${this.url(pool)}?updateMask=scaling`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${await this.tokens.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ scaling: { manualInstanceCount: count }, etag }),
      },
      what,
      this.timeoutMs,
    );

    const operation = expectJson<Operation>(response, what);
    // A 200 is "the update was accepted", not "the update succeeded": the body
    // is an Operation, and a finished-and-failed one arrives with HTTP 200.
    // banto does not poll a pending Operation — the next event or reconcile
    // reads the pool again anyway, which is a better check than polling — but
    // it must not report a failed one as a write.
    if (operation.error) {
      // The Operation's own message is written by the API and may quote request
      // detail, so only the numeric code is repeated, and only if it is one.
      const code = typeof operation.error.code === "number" ? operation.error.code : -1;
      throw new HttpError(`${what} operation failed (code ${code})`, 200);
    }
  }

  private url(pool: PoolConfig): string {
    return `https://${pool.location}-run.googleapis.com/v2/${poolResourceName(pool)}`;
  }
}
