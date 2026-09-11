import type { TokenSource } from "./google-auth.ts";
import { HttpError, httpRequest } from "./http.ts";
import { ConcurrencyError, type DemandStore, type VersionedState } from "./store.ts";
import type { Fetcher, PoolState } from "./types.ts";
import { emptyPoolState } from "./types.ts";

/**
 * GCS-backed demand state over the JSON API. This is banto's default store.
 *
 * The store needs exactly one thing per pool: read a small JSON document,
 * transform it, write it back, and lose politely when someone else got there
 * first. An object generation plus `ifGenerationMatch` is that lock, and it has
 * been strongly consistent for reads and writes since 2020. The deciding factor
 * for an open-source tool is what it costs to adopt: "create a bucket" is a far
 * lower bar than "enable Firestore in this project", which is a project-level
 * decision with a mode attached to it.
 *
 * The state is stored as plain JSON, so there is no typed-value encoding to
 * write — one reason this file is about half the size of the Firestore one.
 */

export interface GcsOptions {
  bucket: string;
  /** Object name prefix; one object per pool underneath it. */
  prefix?: string;
  tokens: TokenSource;
  fetchImpl?: Fetcher;
  /** Override for a fake or a private endpoint (STORAGE_EMULATOR_HOST is honoured too). */
  baseUrl?: string;
  timeoutMs?: number;
}

export const DEFAULT_GCS_PREFIX = "banto/";

export class GcsDemandStore implements DemandStore {
  private readonly fetchImpl: Fetcher;
  private readonly baseUrl: string;
  private readonly prefix: string;

  constructor(private readonly options: GcsOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    const emulator = process.env.STORAGE_EMULATOR_HOST;
    this.baseUrl = options.baseUrl ?? emulator ?? "https://storage.googleapis.com";
    this.prefix = options.prefix ?? DEFAULT_GCS_PREFIX;
  }

  async get(key: string): Promise<VersionedState> {
    const url = `${this.baseUrl}/storage/v1/b/${encodeURIComponent(this.options.bucket)}/o/${encodeURIComponent(
      this.objectName(key),
    )}?alt=media`;
    const what = `GCS get ${key}`;
    const response = await httpRequest(
      this.fetchImpl,
      url,
      { headers: { authorization: `Bearer ${await this.options.tokens.token()}` } },
      what,
      this.options.timeoutMs,
    );

    if (response.status === 404) {
      // A pool banto has never written. Same meaning as Firestore's absent
      // document: empty state at version null, which `put` turns into a
      // create-only write. (The 404 body is plain text, not the JSON envelope
      // the rest of the API uses, so it is never parsed.)
      return { state: emptyPoolState(), version: null };
    }
    if (!response.ok) throw new HttpError(what, response.status);

    // A media download carries the generation in a response header, so reading
    // state costs one request rather than a metadata call plus a download.
    const generation = response.headers.get("x-goog-generation");
    // Without it, the next write would send `ifGenerationMatch=0` and conflict
    // forever against an object that plainly exists. Fail the read instead.
    if (!generation) throw new Error(`${what} returned no generation header`);
    return { state: parseState(response.text, key), version: generation };
  }

  async put(key: string, state: PoolState, expectedVersion: string | null): Promise<VersionedState> {
    const object = this.objectName(key);
    // `ifGenerationMatch=0` is GCS's "only if this object does not exist", which
    // is the precondition for the very first write of a pool.
    const query = new URLSearchParams({
      uploadType: "media",
      name: object,
      ifGenerationMatch: expectedVersion ?? "0",
    });
    const url = `${this.baseUrl}/upload/storage/v1/b/${encodeURIComponent(this.options.bucket)}/o?${query}`;

    const what = `GCS put ${key}`;
    const response = await httpRequest(
      this.fetchImpl,
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.options.tokens.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(state),
      },
      what,
      this.options.timeoutMs,
    );

    if (!response.ok) {
      // 412 is a generation mismatch (someone else wrote first). 409 is the
      // create-only race, which GCS can report when two writers both believe
      // the object is absent. Both mean "read again and retry", which is what
      // `mutate` does with a ConcurrencyError.
      if (response.status === 412 || response.status === 409) {
        throw new ConcurrencyError(`GCS generation precondition failed for ${key}`);
      }
      throw new HttpError(what, response.status);
    }

    let metadata: { generation?: string };
    try {
      metadata = JSON.parse(response.text) as { generation?: string };
    } catch {
      throw new Error(`${what} returned a body that is not JSON`);
    }
    // Without a generation the next write has no precondition to hold, which
    // would silently turn compare-and-set into last-writer-wins.
    if (typeof metadata.generation !== "string" || metadata.generation === "") {
      throw new Error(`${what} returned no generation; refusing to continue without a version`);
    }
    return { state, version: metadata.generation };
  }

  private objectName(key: string): string {
    // Pool names come from validated config; fold anything structural into `_`
    // so a name cannot climb out of the prefix.
    return `${this.prefix}${key.replaceAll("/", "_")}.json`;
  }
}

/**
 * Parse a stored document defensively.
 *
 * Invalid JSON throws rather than silently reading as empty state: empty state
 * means "never seen busy", which satisfies the idle cooldown, and a corrupt
 * object should stop banto rather than license a scale-down. Individual fields
 * are read tolerantly, so a document written by an older version still loads.
 */
export function parseState(body: string, key: string): PoolState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // The parse error's message quotes the input, and the input is a stored
    // document that may hold anything; only the pool key is named.
    throw new Error(`GCS object for ${key} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`GCS object for ${key} is not a demand state document`);
  }

  const record = parsed as Record<string, unknown>;
  return {
    lastBusyAt: asNumber(record.lastBusyAt),
    shortfallSince: asNumber(record.shortfallSince),
  };
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
