import { describe, expect, test } from "bun:test";
import { FirestoreDemandStore } from "../src/firestore.ts";
import { GcsDemandStore } from "../src/gcs.ts";
import { staticTokenSource } from "../src/google-auth.ts";
import { type DemandStore, MemoryDemandStore } from "../src/store.ts";
import type { Fetcher, PoolState } from "../src/types.ts";

/**
 * Deeply required: `Required<T>` only fills in the top level, so an optional
 * field added inside a nested object would compile against a shallow sample and
 * quietly go unchecked.
 */
type DeepRequired<T> = T extends (infer U)[]
  ? DeepRequired<U>[]
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<NonNullable<T[K]>> }
    : T;

/**
 * Every backend must preserve every field of PoolState.
 *
 * This exists because a hand-written codec that silently drops a field is not a
 * visible bug: the feature that field serves simply stops working in production
 * while every other test — which runs against the in-memory store — still
 * passes. The `Required<PoolState>` annotation is the other half of the guard:
 * adding a field to the type without adding it here fails to compile, and
 * adding it here without teaching the codecs fails these assertions.
 */
const SAMPLE: DeepRequired<PoolState> = {
  lastBusyAt: 1_700_000_003_000,
  shortfallSince: 1_700_000_004_000,
};

/** The field list, restated independently of the type, so a rename is caught. */
const EXPECTED_FIELDS = ["lastBusyAt", "shortfallSince"];

/** An in-memory Firestore document, exercising the real REST codec. */
function firestoreStore(): DemandStore {
  let document: { fields: unknown; updateTime: string } | null = null;
  let version = 0;
  const fetchImpl: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(":commit")) {
      const body = JSON.parse(String(init?.body));
      version += 1;
      document = { fields: body.writes[0].update.fields, updateTime: `v${version}` };
      return Response.json({ writeResults: [{ updateTime: document.updateTime }] });
    }
    if (!document) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
    return Response.json({ name: "doc", fields: document.fields, updateTime: document.updateTime });
  };
  return new FirestoreDemandStore({
    project: "p",
    collection: "banto-pools",
    tokens: staticTokenSource("t"),
    fetchImpl,
  });
}

/** An in-memory GCS object, exercising the real JSON codec. */
function gcsStore(): DemandStore {
  let object: { body: string; generation: number } | null = null;
  let generation = 0;
  const fetchImpl: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/upload/")) {
      generation += 1;
      object = { body: String(init?.body ?? ""), generation };
      return Response.json({ generation: String(generation) });
    }
    if (!object) return new Response("No such object", { status: 404 });
    return new Response(object.body, { headers: { "x-goog-generation": String(object.generation) } });
  };
  return new GcsDemandStore({ bucket: "b", tokens: staticTokenSource("t"), fetchImpl });
}

const BACKENDS: [string, () => DemandStore][] = [
  ["memory", () => new MemoryDemandStore()],
  ["firestore", firestoreStore],
  ["gcs", gcsStore],
];

describe("PoolState survives every store", () => {
  test("the sample covers every field of PoolState", () => {
    expect(Object.keys(SAMPLE).sort()).toEqual(EXPECTED_FIELDS);
  });

  for (const [name, make] of BACKENDS) {
    test(`${name}: every field round-trips through put and get`, async () => {
      const store = make();
      await store.put("default", SAMPLE, null);
      const read = await store.get("default");

      for (const field of EXPECTED_FIELDS) {
        expect({ field, value: read.state[field as keyof PoolState] }).toEqual({
          field,
          value: SAMPLE[field as keyof PoolState],
        });
      }
      expect(read.state).toEqual(SAMPLE);
    });

    test(`${name}: cleared and empty values round-trip too`, async () => {
      // The null and zero shapes are the ones a codec is most likely to drop.
      const cleared: PoolState = { lastBusyAt: null, shortfallSince: null };
      const store = make();
      await store.put("default", cleared, null);
      expect((await store.get("default")).state).toEqual(cleared);
    });
  }
});
