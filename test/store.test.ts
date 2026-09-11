import { describe, expect, test } from "bun:test";
import { decodeState, encodeState, FirestoreDemandStore } from "../src/firestore.ts";
import { staticTokenSource } from "../src/google-auth.ts";
import { ConcurrencyError, type DemandStore, MemoryDemandStore, mutate } from "../src/store.ts";
import { emptyPoolState } from "../src/types.ts";

const T0 = 1_700_000_000_000;

describe("MemoryDemandStore", () => {
  test("returns empty state and a null version for an unknown key", async () => {
    const store = new MemoryDemandStore();
    const read = await store.get("default");
    expect(read.version).toBeNull();
    expect(read.state).toEqual(emptyPoolState());
  });

  test("round-trips state and hands back a new version", async () => {
    const store = new MemoryDemandStore();
    const state = { ...emptyPoolState(), lastBusyAt: T0 };
    const written = await store.put("default", state, null);
    expect(written.version).not.toBeNull();
    const read = await store.get("default");
    expect(read.state).toEqual(state);
    expect(read.version).toBe(written.version);
  });

  test("rejects a write whose expected version is stale", async () => {
    const store = new MemoryDemandStore();
    const first = await store.get("default");
    await store.put("default", emptyPoolState(), first.version);
    // A second writer that read at the same moment still holds `first.version`.
    await expect(store.put("default", emptyPoolState(), first.version)).rejects.toThrow(ConcurrencyError);
  });

  test("rejects a create when the document already exists", async () => {
    const store = new MemoryDemandStore();
    await store.put("default", emptyPoolState(), null);
    await expect(store.put("default", emptyPoolState(), null)).rejects.toThrow(ConcurrencyError);
  });

  test("stores a copy, so a later mutation of the caller's object is not visible", async () => {
    const store = new MemoryDemandStore();
    const state = { ...emptyPoolState(), lastBusyAt: T0 };
    await store.put("default", state, null);
    state.lastBusyAt = T0 + 10_000;
    expect((await store.get("default")).state.lastBusyAt).toBe(T0);
  });
});

describe("mutate", () => {
  test("two concurrent writers both land: no update is lost", async () => {
    const store = new MemoryDemandStore();
    await Promise.all([
      mutate(store, "default", (s) => ({ ...s, lastBusyAt: T0 })),
      mutate(store, "default", (s) => ({ ...s, shortfallSince: T0 + 5 })),
    ]);
    const final = await store.get("default");
    expect(final.state).toEqual({ lastBusyAt: T0, shortfallSince: T0 + 5 });
  });

  test("a crowd of concurrent writers all land", async () => {
    const store = new MemoryDemandStore();
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    await Promise.all(
      ids.map((id) =>
        mutate(store, "default", (s) => ({ ...s, lastBusyAt: Math.max(s.lastBusyAt ?? 0, T0 + id) }), {
          attempts: 50,
          sleep: async () => {},
        }),
      ),
    );
    expect((await store.get("default")).state.lastBusyAt).toBe(T0 + 12);
  });

  test("gives up after the retry budget rather than looping forever", async () => {
    // A store that always claims the version moved: mutate must not spin.
    let attempts = 0;
    const hostile: DemandStore = {
      async get() {
        return { state: emptyPoolState(), version: "stale" };
      },
      async put() {
        attempts++;
        throw new ConcurrencyError();
      },
    };
    await expect(
      mutate(hostile, "default", (s) => s, { attempts: 3, sleep: async () => {} }),
    ).rejects.toThrow(ConcurrencyError);
    expect(attempts).toBe(3);
  });

  test("does not retry an error that is not a conflict", async () => {
    let attempts = 0;
    const broken: DemandStore = {
      async get() {
        return { state: emptyPoolState(), version: null };
      },
      async put() {
        attempts++;
        throw new Error("HTTP 503");
      },
    };
    await expect(mutate(broken, "default", (s) => s)).rejects.toThrow("HTTP 503");
    expect(attempts).toBe(1);
  });
});

describe("FirestoreDemandStore", () => {
  const state = { lastBusyAt: T0, shortfallSince: T0 + 1_000 };

  test("document encoding round-trips", () => {
    expect(decodeState(encodeState(state))).toEqual(state);
  });

  test("encodes a null cooldown anchor as nullValue", () => {
    expect(encodeState(emptyPoolState()).lastBusyAt).toEqual({ nullValue: null });
    expect(decodeState(encodeState(emptyPoolState())).lastBusyAt).toBeNull();
  });

  test("a missing document reads as empty state at version null", async () => {
    const store = new FirestoreDemandStore({
      project: "p",
      collection: "banto-pools",
      tokens: staticTokenSource("t"),
      fetchImpl: async () => new Response("{}", { status: 404 }),
    });
    const read = await store.get("default");
    expect(read.version).toBeNull();
    expect(read.state).toEqual(emptyPoolState());
  });

  test("a read carries the document updateTime as its version", async () => {
    const store = new FirestoreDemandStore({
      project: "p",
      collection: "banto-pools",
      tokens: staticTokenSource("t"),
      fetchImpl: async () =>
        Response.json({ name: "x", fields: encodeState(state), updateTime: "2026-09-11T00:00:00.1Z" }),
    });
    const read = await store.get("default");
    expect(read.version).toBe("2026-09-11T00:00:00.1Z");
    expect(read.state).toEqual(state);
  });

  test("a write sends the version as a currentDocument precondition", async () => {
    let body: any;
    const store = new FirestoreDemandStore({
      project: "p",
      collection: "banto-pools",
      tokens: staticTokenSource("t"),
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ writeResults: [{ updateTime: "2026-09-11T00:00:01Z" }] });
      },
    });
    const written = await store.put("default", state, "2026-09-11T00:00:00Z");
    expect(body.writes[0].currentDocument).toEqual({ updateTime: "2026-09-11T00:00:00Z" });
    expect(body.writes[0].update.name).toBe("projects/p/databases/(default)/documents/banto-pools/default");
    expect(written.version).toBe("2026-09-11T00:00:01Z");
  });

  test("a first write asserts the document does not exist", async () => {
    let body: any;
    const store = new FirestoreDemandStore({
      project: "p",
      collection: "banto-pools",
      tokens: staticTokenSource("t"),
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ writeResults: [{ updateTime: "2026-09-11T00:00:01Z" }] });
      },
    });
    await store.put("default", state, null);
    expect(body.writes[0].currentDocument).toEqual({ exists: false });
  });

  test("a failed precondition surfaces as ConcurrencyError", async () => {
    const store = new FirestoreDemandStore({
      project: "p",
      collection: "banto-pools",
      tokens: staticTokenSource("t"),
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { status: "FAILED_PRECONDITION" } }), { status: 400 }),
    });
    await expect(store.put("default", state, "v1")).rejects.toThrow(ConcurrencyError);
  });

  test("other HTTP failures are not mistaken for conflicts", async () => {
    const store = new FirestoreDemandStore({
      project: "p",
      collection: "banto-pools",
      tokens: staticTokenSource("t"),
      fetchImpl: async () => new Response("boom", { status: 503 }),
    });
    const error = await store.put("default", state, "v1").catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConcurrencyError);
  });
});
