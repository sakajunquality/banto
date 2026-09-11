import { describe, expect, test } from "bun:test";

import { GcsDemandStore, parseState } from "../src/gcs.ts";
import { staticTokenSource } from "../src/google-auth.ts";
import { ConcurrencyError, mutate } from "../src/store.ts";
import { emptyPoolState } from "../src/types.ts";
import type { Fetcher } from "../src/types.ts";

const T0 = 1_700_000_000_000;
const STATE = { lastBusyAt: T0, shortfallSince: T0 + 1_000 };

function store(fetchImpl: Fetcher, prefix?: string) {
  return new GcsDemandStore({
    bucket: "banto-state",
    tokens: staticTokenSource("token"),
    fetchImpl,
    ...(prefix === undefined ? {} : { prefix }),
  });
}

/** A tiny in-memory GCS: one object, one generation counter, real preconditions. */
function fakeGcs(initial: { body: string; generation: number } | null = null) {
  let object = initial;
  let generation = initial?.generation ?? 0;
  const requests: string[] = [];

  const fetchImpl: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);

    if (url.pathname.startsWith("/upload/")) {
      const expected = url.searchParams.get("ifGenerationMatch");
      const actual = object === null ? 0 : object.generation;
      if (String(actual) !== expected) {
        return new Response(JSON.stringify({ error: { code: 412 } }), { status: 412 });
      }
      generation += 1;
      object = { body: String(init?.body ?? ""), generation };
      return Response.json({ generation: String(generation) });
    }

    if (object === null) return new Response("No such object", { status: 404 });
    return new Response(object.body, {
      status: 200,
      headers: { "x-goog-generation": String(object.generation) },
    });
  };

  return { fetchImpl, requests, current: () => object };
}

describe("GcsDemandStore", () => {
  test("a missing object reads as empty state at version null", async () => {
    const gcs = fakeGcs(null);
    const read = await store(gcs.fetchImpl).get("default");
    expect(read.version).toBeNull();
    expect(read.state).toEqual(emptyPoolState());
  });

  test("the first write is create-only (ifGenerationMatch=0)", async () => {
    const gcs = fakeGcs(null);
    const written = await store(gcs.fetchImpl).put("default", STATE, null);
    expect(written.version).toBe("1");
    expect(gcs.requests.at(-1)).toContain("ifGenerationMatch=0");
    expect(gcs.requests.at(-1)).toContain("name=banto%2Fdefault.json");
  });

  test("state round-trips through the object body", async () => {
    const gcs = fakeGcs(null);
    const s = store(gcs.fetchImpl);
    await s.put("default", STATE, null);
    const read = await s.get("default");
    expect(read.state).toEqual(STATE);
    expect(read.version).toBe("1");
  });

  test("a write with the matching generation succeeds and returns the new one", async () => {
    const gcs = fakeGcs(null);
    const s = store(gcs.fetchImpl);
    const first = await s.put("default", STATE, null);
    const second = await s.put("default", STATE, first.version);
    expect(second.version).toBe("2");
  });

  test("a stale generation is a ConcurrencyError, not a silent overwrite", async () => {
    const gcs = fakeGcs(null);
    const s = store(gcs.fetchImpl);
    await s.put("default", STATE, null);
    await expect(s.put("default", STATE, "1")).resolves.toBeDefined();
    // "1" is now stale: the object is at generation 2.
    await expect(s.put("default", STATE, "1")).rejects.toThrow(ConcurrencyError);
  });

  test("a create that loses the race is a ConcurrencyError too", async () => {
    const gcs = fakeGcs(null);
    const s = store(gcs.fetchImpl);
    await s.put("default", STATE, null);
    await expect(s.put("default", STATE, null)).rejects.toThrow(ConcurrencyError);
  });

  test("mutate retries the conflict rather than losing a write", async () => {
    const gcs = fakeGcs(null);
    const s = store(gcs.fetchImpl);
    await Promise.all([
      mutate(s, "default", (state) => ({ ...state, lastBusyAt: T0 }), { sleep: async () => {} }),
      mutate(s, "default", (state) => ({ ...state, shortfallSince: T0 + 5 }), { sleep: async () => {} }),
    ]);
    const final = (await s.get("default")).state;
    expect(final.lastBusyAt).toBe(T0);
    expect(final.shortfallSince).toBe(T0 + 5);
  });

  test("the generation comes from the media download's own header", async () => {
    const gcs = fakeGcs({ body: JSON.stringify(STATE), generation: 42 });
    const read = await store(gcs.fetchImpl).get("default");
    expect(read.version).toBe("42");
    // One request: no separate metadata call.
    expect(gcs.requests).toHaveLength(1);
    expect(gcs.requests[0]).toContain("alt=media");
  });

  test("a malformed body is an error, not an empty pool", async () => {
    // Empty state reads as zero demand, and zero demand is a scale-down: a
    // corrupt object must stop banto, not shrink the pool.
    const s = store(async () => new Response("{not json", { status: 200, headers: { "x-goog-generation": "3" } }));
    await expect(s.get("default")).rejects.toThrow("not valid JSON");
  });

  test("a JSON body of the wrong shape is an error", async () => {
    const s = store(async () => new Response("[1,2,3]", { status: 200, headers: { "x-goog-generation": "3" } }));
    await expect(s.get("default")).rejects.toThrow("not a demand state document");
  });

  test("a non-precondition failure propagates instead of being swallowed", async () => {
    const s = store(async () => new Response("upstream is unhappy", { status: 503 }));
    const readError = await s.get("default").catch((e) => e);
    expect(readError).toBeInstanceOf(Error);
    expect(readError).not.toBeInstanceOf(ConcurrencyError);
    expect(String(readError)).toContain("HTTP 503");
    // Nothing the other end wrote is quoted back into the message.
    expect(String(readError)).not.toContain("unhappy");

    const writeError = await s.put("default", STATE, "1").catch((e) => e);
    expect(writeError).not.toBeInstanceOf(ConcurrencyError);
    expect(String(writeError)).toContain("HTTP 503");
  });

  test("a write that comes back without a generation is refused", async () => {
    const s = store(async () => Response.json({}));
    await expect(s.put("default", STATE, null)).rejects.toThrow("no generation");
  });

  test("the object prefix is configurable and URL-encoded", async () => {
    const gcs = fakeGcs(null);
    await store(gcs.fetchImpl, "teams/ci/").put("default", STATE, null);
    expect(gcs.requests.at(-1)).toContain("name=teams%2Fci%2Fdefault.json");
  });
});

describe("stored document parsing", () => {
  test("keeps what it understands and ignores the rest", () => {
    const parsed = parseState(
      JSON.stringify({
        lastBusyAt: T0,
        shortfallSince: "not a number",
        jobs: { "1": "a field an older version wrote" },
      }),
      "default",
    );
    expect(parsed).toEqual({ lastBusyAt: T0, shortfallSince: null });
  });
});

describe("GCS read edge cases", () => {
  test("a response without a generation header is a read failure", async () => {
    // Treating it as version null would send the next write as create-only and
    // conflict forever against an object that plainly exists.
    const s = store(async () => new Response(JSON.stringify(STATE), { status: 200 }));
    await expect(s.get("default")).rejects.toThrow("no generation header");
  });

  test("the plain-text 404 body is never parsed", async () => {
    // GCS answers a missing object with text, not the JSON envelope the rest of
    // the API uses.
    const s = store(async () => new Response("No such object: b/banto/default.json", { status: 404 }));
    const read = await s.get("default");
    expect(read.version).toBeNull();
  });
});
