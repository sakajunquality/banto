import { describe, expect, test } from "bun:test";
import { Controller } from "../src/controller.ts";
import { nullLogger } from "../src/log.ts";
import type { TokenVerifier } from "../src/oidc.ts";
import { createApp } from "../src/server.ts";
import { signBody } from "../src/signature.ts";
import { MemoryDemandStore } from "../src/store.ts";
import { FakeClock, FakeGitHub, FakeWorkerPools, jobsFor, pool } from "./helpers.ts";

const SECRET = "webhook-secret";
const INSTALLATION = "98765432";
const POOL = pool({ name: "default", labels: ["self-hosted", "runner-default"] });

/** A verifier that accepts nothing, for the routes that are not about auth. */
const REJECTING: TokenVerifier = {
  verify: async () => {
    throw new Error("no token accepted");
  },
};

function harness(verifier: TokenVerifier = REJECTING, maxBodyBytes?: number, bodyTimeoutMs?: number) {
  const workerPools = new FakeWorkerPools();
  // One queued job for the pool, so an accepted delivery has something to act
  // on: a pass computes demand from GitHub rather than from the payload.
  const github = new FakeGitHub(jobsFor([42], ["self-hosted", "runner-default"]));
  const controller = new Controller({
    pools: [POOL],
    store: new MemoryDemandStore(),
    workerPools,
    github,
    clock: new FakeClock(),
    logger: nullLogger,
    minPassIntervalMs: 0,
  });
  const app = createApp({
    controller,
    webhookSecret: SECRET,
    logger: nullLogger,
    reconcileVerifier: verifier,
    installationId: INSTALLATION,
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    ...(bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs }),
  });
  return { app, workerPools, github };
}

function webhook(body: unknown, options: { secret?: string; event?: string; signature?: string | null } = {}) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.event !== undefined) headers["x-github-event"] = options.event;
  else headers["x-github-event"] = "workflow_job";
  const signature = options.signature === undefined ? signBody(options.secret ?? SECRET, raw) : options.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return new Request("http://banto.test/webhook", { method: "POST", headers, body: raw });
}

const accepting: TokenVerifier = {
  verify: async (token) => {
    if (token !== "good-token") throw new Error("bad token");
    return { sub: "123", email: "scheduler@example.iam.gserviceaccount.com", aud: "https://banto.test" };
  },
};

const QUEUED = {
  action: "queued",
  workflow_job: { id: 42, labels: ["self-hosted", "runner-default"] },
  repository: { full_name: "example-org/infra" },
  installation: { id: Number(INSTALLATION) },
};

describe("HTTP surface", () => {
  test("GET /healthz needs no credentials", async () => {
    const { app } = harness();
    const response = await app.request("http://banto.test/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("a correctly signed workflow_job is acted on", async () => {
    const { app, workerPools } = harness();
    const response = await app.request(webhook(QUEUED));
    expect(response.status).toBe(200);
    expect(workerPools.writes).toEqual([{ pool: "default", count: 1 }]);
  });

  test("a webhook signed with the wrong secret is rejected and changes nothing", async () => {
    const { app, workerPools } = harness();
    const response = await app.request(webhook(QUEUED, { secret: "not-the-secret" }));
    expect(response.status).toBe(401);
    expect(workerPools.writes).toEqual([]);
  });

  test("a webhook with no signature header is rejected", async () => {
    const { app } = harness();
    expect((await app.request(webhook(QUEUED, { signature: null }))).status).toBe(401);
  });

  test("a body rewritten after signing is rejected", async () => {
    const { app, workerPools } = harness();
    const raw = JSON.stringify(QUEUED);
    const signature = signBody(SECRET, raw);
    const response = await app.request(
      new Request("http://banto.test/webhook", {
        method: "POST",
        headers: { "x-github-event": "workflow_job", "x-hub-signature-256": signature },
        body: raw.replace('"id":42', '"id":43'),
      }),
    );
    expect(response.status).toBe(401);
    expect(workerPools.writes).toEqual([]);
  });

  test("ping is answered without touching any pool", async () => {
    const { app, workerPools } = harness();
    const response = await app.request(webhook({ zen: "hello" }, { event: "ping" }));
    expect(response.status).toBe(200);
    expect(workerPools.writes).toEqual([]);
  });

  test("a signed event of another type is acknowledged and ignored", async () => {
    const { app } = harness();
    const response = await app.request(webhook({ action: "opened" }, { event: "push" }));
    expect(response.status).toBe(202);
  });

  test("a signed body that is not a workflow_job payload is a 400", async () => {
    const { app } = harness();
    const response = await app.request(webhook({ action: "queued" }));
    expect(response.status).toBe(400);
  });

  test("a body whose bytes are not valid UTF-8 cannot be laundered through a re-encode", async () => {
    // The signature is over the bytes GitHub sent. Decoding to a string and
    // encoding back turns any invalid byte into U+FFFD, so a body carrying
    // 0xff would hash the same as one carrying the replacement character and
    // verify against the original signature.
    // The two bodies below are what a re-encode would conflate. `laundered`
    // carries U+FFFD where `raw` carries the bare 0xff, which is exactly what
    // `TextDecoder` produces for that byte — so an implementation that decoded
    // to a string and encoded back would hash them identically.
    //
    // Signing `laundered` and sending `raw` is the discriminating direction. A
    // byte-exact implementation rejects, because the bytes differ. A
    // re-encoding one accepts, because after laundering they do not. Signing
    // and sending the *same* altered body proves nothing: that is refused
    // either way, which is what this test used to do.
    const base = new TextEncoder().encode(JSON.stringify(QUEUED));
    const raw = new Uint8Array([...base.slice(0, -1), 0xff, base[base.length - 1]!]);
    const laundered = new TextEncoder().encode(new TextDecoder().decode(raw));
    expect(Buffer.compare(Buffer.from(raw), Buffer.from(laundered))).not.toBe(0);
    expect(new TextDecoder().decode(raw)).toBe(new TextDecoder().decode(laundered));

    const { app, workerPools } = harness();
    const response = await app.request(
      new Request("http://banto.test/webhook", {
        method: "POST",
        headers: { "x-github-event": "workflow_job", "x-hub-signature-256": signBody(SECRET, laundered) },
        body: raw,
      }),
    );
    expect(response.status).toBe(401);
    expect(workerPools.writes).toEqual([]);
  });

  test("rejects a body past the size cap", async () => {
    const { app } = harness(REJECTING, 1024);
    const big = "x".repeat(4096);
    const response = await app.request(
      new Request("http://banto.test/webhook", {
        method: "POST",
        headers: { "x-github-event": "workflow_job", "x-hub-signature-256": signBody(SECRET, big) },
        body: big,
      }),
    );
    expect(response.status).toBe(413);
  });

  test("a body that stops mid-stream is a timeout, not a short read", async () => {
    // Cancelling the reader makes the next read report `done`; without the
    // explicit check that would hand a truncated body on as a complete one.
    const { app, workerPools } = harness(REJECTING, undefined, 20);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"action":"queued"'));
        // Never closed.
      },
    });
    const response = await app.request(
      new Request("http://banto.test/webhook", {
        method: "POST",
        headers: { "x-github-event": "workflow_job", "x-hub-signature-256": signBody(SECRET, "anything") },
        body,
        duplex: "half",
      }),
    );
    expect(response.status).toBe(408);
    expect(workerPools.writes).toEqual([]);
  });

  test("checks for the signature before it looks at the body", async () => {
    // An oversized *and* unsigned request comes back 401, not 413: the cheap
    // rejection happens first, so an unsigned caller cannot make banto buffer.
    const { app } = harness(REJECTING, 1024);
    const response = await app.request(
      new Request("http://banto.test/webhook", {
        method: "POST",
        headers: { "x-github-event": "workflow_job" },
        body: "x".repeat(4096),
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("installation and repository scoping", () => {
  test("a signed event from another installation of the same App is refused", async () => {
    // Same App, same webhook secret, someone else's CI: a valid signature is
    // not authorization.
    const { app, workerPools } = harness();
    const response = await app.request(webhook({ ...QUEUED, installation: { id: 999 } }));
    expect(response.status).toBe(403);
    expect(workerPools.writes).toEqual([]);
  });

  test("an event with no installation at all is refused", async () => {
    const { app } = harness();
    const { installation, ...withoutInstallation } = QUEUED;
    expect((await app.request(webhook(withoutInstallation))).status).toBe(403);
  });

  test("the repository allowlist is enforced when one is configured", async () => {
    const workerPools = new FakeWorkerPools();
    const controller = new Controller({
      pools: [POOL],
      store: new MemoryDemandStore(),
      workerPools,
      github: new FakeGitHub(jobsFor([42], ["self-hosted", "runner-default"])),
      clock: new FakeClock(),
      logger: nullLogger,
      minPassIntervalMs: 0,
    });
    const app = createApp({
      controller,
      webhookSecret: SECRET,
      logger: nullLogger,
      reconcileVerifier: REJECTING,
      installationId: INSTALLATION,
      allowedRepositories: ["example-org/infra"],
    });
    expect((await app.request(webhook(QUEUED))).status).toBe(200);
    const other = { ...QUEUED, repository: { full_name: "someone-else/repo" } };
    expect((await app.request(webhook(other))).status).toBe(403);
    expect(workerPools.writes).toHaveLength(1);
  });

  test("a signed body that is not JSON is a 400, not a crash", async () => {
    const raw = "not json";
    const { app } = harness();
    const response = await app.request(
      new Request("http://banto.test/webhook", {
        method: "POST",
        headers: { "x-github-event": "workflow_job", "x-hub-signature-256": signBody(SECRET, raw) },
        body: raw,
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("/reconcile authentication", () => {
  test("runs for a caller with a valid ID token", async () => {
    const { app, github } = harness(accepting);
    const response = await app.request(
      new Request("http://banto.test/reconcile", {
        method: "POST",
        headers: { authorization: "Bearer good-token" },
      }),
    );
    expect(response.status).toBe(200);
    expect(github.calls).toBe(1);
  });

  test("rejects a missing bearer token", async () => {
    const { app, github } = harness(accepting);
    const response = await app.request(new Request("http://banto.test/reconcile", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(github.calls).toBe(0);
  });

  test("rejects a token the verifier refuses", async () => {
    const { app, github } = harness(accepting);
    const response = await app.request(
      new Request("http://banto.test/reconcile", {
        method: "POST",
        headers: { authorization: "Bearer forged" },
      }),
    );
    expect(response.status).toBe(401);
    expect(github.calls).toBe(0);
  });

  test("a reconcile where a pool failed is a 500, so Cloud Scheduler retries", async () => {
    const { app, workerPools } = harness(accepting);
    workerPools.failNextGet = new Error("HTTP 503 from Cloud Run");
    const response = await app.request(
      new Request("http://banto.test/reconcile", {
        method: "POST",
        headers: { authorization: "Bearer good-token" },
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: "partial_failure" });
  });
});
