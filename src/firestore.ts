import type { TokenSource } from "./google-auth.ts";
import { expectJson, HttpError, httpRequest } from "./http.ts";
import { ConcurrencyError, type DemandStore, type VersionedState } from "./store.ts";
import type { Fetcher, PoolState } from "./types.ts";
import { emptyPoolState } from "./types.ts";

/**
 * Firestore-backed demand state over the REST API.
 *
 * One document per pool. Reads return the document's `updateTime`, writes go
 * through `documents:commit` with a `currentDocument` precondition built from
 * it (`exists: false` for a document we believe is absent). Firestore rejects
 * the commit if the document moved in between, which is exactly the optimistic
 * concurrency `DemandStore` asks for: two webhooks racing cannot lose an
 * update, the loser retries on fresh state.
 *
 * A transaction would work too, but a single-document compare-and-set needs no
 * transaction, no rollback path, and no second round trip.
 */

export interface FirestoreOptions {
  project: string;
  database?: string;
  collection: string;
  tokens: TokenSource;
  fetchImpl?: Fetcher;
  /** Override for the emulator (FIRESTORE_EMULATOR_HOST is honoured too). */
  baseUrl?: string;
  timeoutMs?: number;
}

export class FirestoreDemandStore implements DemandStore {
  private readonly database: string;
  private readonly fetchImpl: Fetcher;
  private readonly root: string;
  private readonly baseUrl: string;

  constructor(private readonly options: FirestoreOptions) {
    this.database = options.database ?? "(default)";
    this.fetchImpl = options.fetchImpl ?? fetch;
    const emulator = process.env.FIRESTORE_EMULATOR_HOST;
    this.baseUrl = options.baseUrl ?? (emulator ? `http://${emulator}/v1` : "https://firestore.googleapis.com/v1");
    this.root = `projects/${options.project}/databases/${this.database}/documents`;
  }

  async get(key: string): Promise<VersionedState> {
    const what = `Firestore get ${key}`;
    const response = await httpRequest(
      this.fetchImpl,
      `${this.baseUrl}/${this.documentName(key)}`,
      { headers: { authorization: `Bearer ${await this.options.tokens.token()}`, accept: "application/json" } },
      what,
      this.options.timeoutMs,
    );
    if (response.status === 404) return { state: emptyPoolState(), version: null };
    const doc = expectJson<Record<string, unknown>>(response, what);
    return {
      state: decodeState(doc.fields as Record<string, FirestoreValue> | undefined),
      version: typeof doc.updateTime === "string" ? doc.updateTime : null,
    };
  }

  async put(key: string, state: PoolState, expectedVersion: string | null): Promise<VersionedState> {
    const body = {
      writes: [
        {
          update: { name: `${this.root}/${this.documentId(key)}`, fields: encodeState(state) },
          currentDocument: expectedVersion === null ? { exists: false } : { updateTime: expectedVersion },
        },
      ],
    };
    const what = `Firestore commit ${key}`;
    const response = await httpRequest(
      this.fetchImpl,
      `${this.baseUrl}/${this.root}:commit`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.options.tokens.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      what,
      this.options.timeoutMs,
    );

    if (!response.ok) {
      // The status code alone distinguishes a conflict. The body is inspected
      // for Firestore's status string but never repeated anywhere.
      if (isPreconditionFailure(response.status, response.text)) {
        throw new ConcurrencyError(`Firestore precondition failed for ${key}`);
      }
      throw new HttpError(what, response.status);
    }

    const result = expectJson<{ writeResults?: { updateTime?: string }[] }>(response, what);
    return { state, version: result.writeResults?.[0]?.updateTime ?? null };
  }

  private documentId(key: string): string {
    // Pool names come from validated config, but a `/` would silently address
    // a subcollection, so fold anything structural into `_`.
    return `${this.options.collection}/${key.replaceAll("/", "_")}`;
  }

  private documentName(key: string): string {
    return `${this.root}/${this.documentId(key)}`;
  }

}

function isPreconditionFailure(status: number, body: string): boolean {
  if (status === 409 || status === 412) return true;
  return status === 400 && (body.includes("FAILED_PRECONDITION") || body.includes("ALREADY_EXISTS"));
}

// --- document encoding -----------------------------------------------------
// Firestore's REST JSON is typed values, so the state is mapped by hand. There
// is very little to map: banto persists only what it cannot recompute.
// Timestamps are stored as integerValue (epoch ms) rather than timestampValue,
// because the arithmetic downstream is in milliseconds.

type FirestoreValue =
  | { nullValue: null }
  | { stringValue: string }
  | { integerValue: string }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

export function encodeState(state: PoolState): Record<string, FirestoreValue> {
  return {
    lastBusyAt: nullableInt(state.lastBusyAt ?? null),
    shortfallSince: nullableInt(state.shortfallSince ?? null),
  };
}

export function decodeState(fields: Record<string, FirestoreValue> | undefined): PoolState {
  if (!fields) return emptyPoolState();
  return {
    lastBusyAt: intOf(fields.lastBusyAt),
    shortfallSince: intOf(fields.shortfallSince),
  };
}

function nullableInt(value: number | null): FirestoreValue {
  return value === null ? { nullValue: null } : { integerValue: String(value) };
}

function intOf(value: FirestoreValue | undefined): number | null {
  if (!value || !("integerValue" in value)) return null;
  const parsed = Number(value.integerValue);
  return Number.isFinite(parsed) ? parsed : null;
}
