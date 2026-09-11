import { describe, expect, test } from "bun:test";
import { CloudRunWorkerPoolClient } from "../src/cloudrun.ts";
import { staticTokenSource } from "../src/google-auth.ts";
import { createLogger } from "../src/log.ts";
import { pool } from "./helpers.ts";

const POOL = pool({ project: "proj", location: "asia-northeast1", workerPool: "gh-runner-default" });

describe("Cloud Run worker pool client", () => {
  test("reads the manual instance count from the regional endpoint", async () => {
    let seen = "";
    const client = new CloudRunWorkerPoolClient(staticTokenSource("token"), async (input) => {
      seen = String(input);
      return Response.json({ scaling: { manualInstanceCount: 3 }, etag: "abc" });
    });
    const state = await client.get(POOL);
    expect(seen).toBe(
      "https://asia-northeast1-run.googleapis.com/v2/projects/proj/locations/asia-northeast1/workerPools/gh-runner-default",
    );
    expect(state).toEqual({ instanceCount: 3, etag: "abc" });
  });

  test("treats an absent count as zero, which is how Cloud Run renders it", async () => {
    const client = new CloudRunWorkerPoolClient(staticTokenSource("token"), async () =>
      Response.json({ scaling: {}, etag: "abc" }),
    );
    expect((await client.get(POOL)).instanceCount).toBe(0);
  });

  test("patches only the scaling field and sends the etag back", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const client = new CloudRunWorkerPoolClient(staticTokenSource("token"), async (input, options) => {
      url = String(input);
      init = options;
      return Response.json({ name: "x" });
    });
    await client.setInstanceCount(POOL, 2, "etag-1");
    expect(url).toContain("?updateMask=scaling");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ scaling: { manualInstanceCount: 2 }, etag: "etag-1" });
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer token");
  });

  test("still sends the etag on a scale to zero", async () => {
    let init: RequestInit | undefined;
    const client = new CloudRunWorkerPoolClient(staticTokenSource("token"), async (_input, options) => {
      init = options;
      return Response.json({});
    });
    await client.setInstanceCount(POOL, 0, "etag-2");
    expect(JSON.parse(String(init?.body))).toEqual({ scaling: { manualInstanceCount: 0 }, etag: "etag-2" });
  });

  test("an API error is raised, not swallowed", async () => {
    const client = new CloudRunWorkerPoolClient(staticTokenSource("token"), async () =>
      new Response(JSON.stringify({ error: { message: "permission denied" } }), { status: 403 }),
    );
    await expect(client.setInstanceCount(POOL, 1, "etag-1")).rejects.toThrow("HTTP 403");
  });
});

describe("logging", () => {
  test("emits one JSON object per line with a Cloud Logging severity", () => {
    const lines: string[] = [];
    const logger = createLogger("INFO", (line) => lines.push(line));
    logger.debug("not emitted at INFO");
    logger.info("scaling decision", { pool: "default", demand: 2, current: 1, desired: 2 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      severity: "INFO",
      message: "scaling decision",
      pool: "default",
      demand: 2,
      current: 1,
      desired: 2,
    });
  });
});

describe("Cloud Run failure handling", () => {
  test("a read without an etag is refused rather than downgraded", async () => {
    // No etag means no conditional write, and an unconditional write can undo
    // someone else's change.
    const client = new CloudRunWorkerPoolClient(staticTokenSource("token"), async () =>
      Response.json({ scaling: { manualInstanceCount: 1 } }),
    );
    await expect(client.get(POOL)).rejects.toThrow("no etag");
  });

  test("an instance count that is not a number is refused, not carried into a decision", async () => {
    // The typed shape handed to `expectJson` is a cast, not a check. The etag
    // is validated a few lines above; without the same check here, whatever the
    // API returned became the count every decision is made against, and was
    // written into the logs verbatim. Refuse it the way a missing etag is
    // refused.
    for (const bad of ["ghs_PLANTED_SECRET", -1, 1.5, {}, [], true, "3"]) {
      const client = new CloudRunWorkerPoolClient(staticTokenSource("token"), async () =>
        Response.json({ scaling: { manualInstanceCount: bad }, etag: "e1" }),
      );
      await expect(client.get(POOL)).rejects.toThrow("unreadable instance count");
    }
  });

  test("an absent instance count still reads as zero", async () => {
    // Cloud Run omits zero-valued integers, so absent must stay readable.
    const client = new CloudRunWorkerPoolClient(staticTokenSource("token"), async () =>
      Response.json({ scaling: {}, etag: "e1" }),
    );
    expect(await client.get(POOL)).toEqual({ instanceCount: 0, etag: "e1" });
  });

  test("a finished-and-failed operation is not reported as a write", async () => {
    // The PATCH returns an Operation; a failed one arrives with HTTP 200.
    const client = new CloudRunWorkerPoolClient(staticTokenSource("token"), async () =>
      Response.json({ name: "operations/x", done: true, error: { code: 7, message: "permission denied" } }),
    );
    await expect(client.setInstanceCount(POOL, 2, "etag-1")).rejects.toThrow("operation failed");
  });

  test("a pending operation is accepted without polling", async () => {
    // The next event or reconcile reads the pool again, which is a better
    // check than polling an operation here.
    const client = new CloudRunWorkerPoolClient(staticTokenSource("token"), async () =>
      Response.json({ name: "operations/x", done: false }),
    );
    await expect(client.setInstanceCount(POOL, 2, "etag-1")).resolves.toBeUndefined();
  });

  test("an error response is not quoted back into the logs", async () => {
    const client = new CloudRunWorkerPoolClient(staticTokenSource("token"), async () =>
      new Response("Bearer ya29.secret was rejected", { status: 403 }),
    );
    const error = await client.get(POOL).catch((e) => e);
    expect(String(error)).toContain("HTTP 403");
    expect(String(error)).not.toContain("ya29.secret");
  });

  test("a hanging call fails on its deadline instead of holding the reconcile", async () => {
    const client = new CloudRunWorkerPoolClient(
      staticTokenSource("token"),
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      20,
    );
    await expect(client.get(POOL)).rejects.toThrow("timed out");
  });
});
