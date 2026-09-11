import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { CloudRunWorkerPoolClient } from "../src/cloudrun.ts";
import { FirestoreDemandStore } from "../src/firestore.ts";
import { GcsDemandStore } from "../src/gcs.ts";
import { GitHubAppClient } from "../src/github.ts";
import { AdcTokenSource, staticTokenSource } from "../src/google-auth.ts";
import { GoogleIdTokenVerifier } from "../src/oidc.ts";
import { createLogger, type Logger } from "../src/log.ts";
import { emptyPoolState, type Fetcher } from "../src/types.ts";
import { pool } from "./helpers.ts";

/**
 * One marker, planted in every response banto can receive, asserted absent from
 * every error it can raise.
 *
 * The rule this defends is "never repeat anything the other end said", and the
 * reason it needs a test of its own is that the leaks are never in the obvious
 * place: they arrive through `JSON.parse` error messages, through interpolated
 * API error fields, and through transport error text — all of which quote their
 * input by default.
 */
const PLANTED = "ghs_PLANTED_SECRET";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

/** Every response shape that can carry text back from an upstream service. */
const POISONED_RESPONSES: [string, () => Response][] = [
  ["error body", () => new Response(`denied: ${PLANTED}`, { status: 403 })],
  ["500 body", () => new Response(`stack trace mentioning ${PLANTED}`, { status: 500 })],
  ["non-JSON success body", () => new Response(`${PLANTED} not json`, { status: 200 })],
  [
    "JSON error envelope",
    () => new Response(JSON.stringify({ error: { message: PLANTED, code: PLANTED } }), { status: 400 }),
  ],
  ["JSON success with a planted message", () => Response.json({ error: { message: PLANTED, code: PLANTED } })],
];

/**
 * Everything a rejection can carry, flattened: a thrown non-Error, a nested
 * `cause`, the members of an `AggregateError`, and the stack. A leak that hides
 * in any of those still reaches a log, because that is what a logger prints.
 */
function describeRejection(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (value instanceof Error) {
    const parts = [value.name, value.message, value.stack ?? ""];
    if (value.cause !== undefined) parts.push(describeRejection(value.cause, depth + 1));
    const aggregate = value as AggregateError;
    if (Array.isArray(aggregate.errors)) {
      for (const inner of aggregate.errors) parts.push(describeRejection(inner, depth + 1));
    }
    return parts.join("\n");
  }
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Run `call` against each poisoned response and return everything observable:
 * the rejection, and anything the code logged on the way.
 */
async function observationsFrom(
  call: (fetchImpl: Fetcher, logger: Logger) => Promise<unknown>,
): Promise<string[]> {
  const observations: string[] = [];
  for (const [, make] of POISONED_RESPONSES) {
    const lines: string[] = [];
    const logger = createLogger("DEBUG", (line) => lines.push(line));
    let rejected = false;
    await call(async () => make(), logger).then(
      () => {},
      (error: unknown) => {
        rejected = true;
        observations.push(describeRejection(error));
      },
    );
    if (lines.length > 0) observations.push(lines.join("\n"));
    // A probe that neither rejected nor logged observed nothing, so asserting
    // "the secret is absent" over it proves nothing. Pushing the joined lines
    // unconditionally hid that, because an empty join is still a string and the
    // array was never empty. Say it out loud instead, and let the callers
    // assert on it.
    if (!rejected && lines.length === 0) observations.push(VACUOUS);
  }
  return observations;
}

/**
 * Marker for a probe that produced no evidence at all. Every caller asserts it
 * is absent: without that, a test can "pass" having exercised nothing.
 */
export const VACUOUS = "<probe produced neither a rejection nor a log line>";

/**
 * Assert the probes observed something, and that none of it leaked.
 *
 * A single probe can legitimately produce nothing: a poisoned body that a
 * client accepts as a valid response neither rejects nor logs, so there is no
 * text for the secret to escape through. What must never happen is *every*
 * probe going quiet — then the loop below iterates over nothing and the test
 * reports success having exercised the code not at all. That is the case this
 * guards, and it is the case the old `for (const m of messages)` form could
 * not see, because an empty join is still a string and the array was never
 * empty.
 */
function expectNoLeak(messages: string[]): void {
  const observed = messages.filter((message) => message !== VACUOUS);
  expect(observed.length).toBeGreaterThan(0);
  for (const message of observed) expect(message).not.toContain(PLANTED);
}

/** A token exchange that succeeds, so poisoned bodies reach the listings. */
function withWorkingTokenExchange(fetchImpl: Fetcher): Fetcher {
  return async (input, init) => {
    if (String(input).includes("/access_tokens")) {
      return Response.json({ token: "ghs_valid", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return fetchImpl(input, init);
  };
}

describe("no upstream text reaches an error message", () => {
  test("Cloud Run: reads, writes and Operation errors", async () => {
    const client = (fetchImpl: Fetcher) => new CloudRunWorkerPoolClient(staticTokenSource("t"), fetchImpl);
    const reads = await observationsFrom((f) => client(f).get(pool()));
    const writes = await observationsFrom((f) => client(f).setInstanceCount(pool(), 1, "etag"));
    expectNoLeak([...reads, ...writes]);
    expect(reads.length + writes.length).toBeGreaterThan(0);
  });

  test("GCS: object reads, writes and stored documents", async () => {
    const store = (fetchImpl: Fetcher) =>
      new GcsDemandStore({ bucket: "b", tokens: staticTokenSource("t"), fetchImpl });
    const reads = await observationsFrom((f) => store(f).get("default"));
    const writes = await observationsFrom((f) => store(f).put("default", emptyPoolState(), null));
    expectNoLeak([...reads, ...writes]);

    // A stored object that is not JSON: the parse error quotes its input.
    const corrupt = new GcsDemandStore({
      bucket: "b",
      tokens: staticTokenSource("t"),
      fetchImpl: async () =>
        new Response(`{${PLANTED}`, { status: 200, headers: { "x-goog-generation": "4" } }),
    });
    const error = await corrupt.get("default").catch((e: unknown) => e);
    expect(String(error)).not.toContain(PLANTED);
  });

  test("Firestore: document reads and commits", async () => {
    const store = (fetchImpl: Fetcher) =>
      new FirestoreDemandStore({ project: "p", collection: "c", tokens: staticTokenSource("t"), fetchImpl });
    const reads = await observationsFrom((f) => store(f).get("default"));
    const writes = await observationsFrom((f) => store(f).put("default", emptyPoolState(), "v1"));
    expectNoLeak([...reads, ...writes]);
  });

  test("GitHub: the token exchange itself", async () => {
    const client = (fetchImpl: Fetcher, logger: Logger) =>
      new GitHubAppClient({ appId: "1", installationId: "2", privateKey: PEM, repos: ["owner/repo"], fetchImpl, logger });
    const messages = await observationsFrom((f, l) => client(f, l).observeJobs());
    expectNoLeak(messages);
  });

  test("GitHub: the listings behind a working token exchange", async () => {
    // Without this the token call consumes every poisoned response and the
    // listing endpoints are never actually exercised.
    const client = (fetchImpl: Fetcher, logger: Logger) =>
      new GitHubAppClient({
        appId: "1",
        installationId: "2",
        privateKey: PEM,
        org: "org",
        repos: ["owner/repo"],
        fetchImpl: withWorkingTokenExchange(fetchImpl),
        logger,
      });
    const jobs = await observationsFrom((f, l) => client(f, l).observeJobs());
    const runners = await observationsFrom((f, l) => client(f, l).observeRunners());
    expectNoLeak([...jobs, ...runners]);
  });

  test("GitHub: the per-run job listing, which the other probes never reach", async () => {
    // A poisoned response to *every* request is consumed by `/runs` first, so
    // `/runs/{id}/jobs` was never exercised by any of the probes above. Serve
    // the run listing cleanly and poison only the jobs endpoint.
    const client = (fetchImpl: Fetcher, logger: Logger) =>
      new GitHubAppClient({
        appId: "1",
        installationId: "2",
        privateKey: PEM,
        repos: ["owner/repo"],
        logger,
        fetchImpl: withWorkingTokenExchange(async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/actions/runs")) {
            return Response.json({ total_count: 1, workflow_runs: [{ id: 100 }] });
          }
          return fetchImpl(input, init);
        }),
      });
    const messages = await observationsFrom((f, l) => client(f, l).observeJobs());
    expectNoLeak(messages);
  });

  test("GitHub: a repository name from the API never reaches an error", async () => {
    // The installation listing is upstream data, and its names are interpolated
    // into request paths. A name chosen by whoever installed the App must not
    // come back out in a message — nor be able to reshape a URL.
    const lines: string[] = [];
    const logger = createLogger("DEBUG", (line) => lines.push(line));
    const client = new GitHubAppClient({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      logger,
      fetchImpl: withWorkingTokenExchange(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/installation/repositories") {
          return Response.json({ repositories: [{ full_name: `owner/${PLANTED}` }] });
        }
        return new Response("gone", { status: 404 });
      }),
    });
    const error = await client.observeJobs().catch((e: unknown) => e);
    expect(`${describeRejection(error)}\n${lines.join("\n")}`).not.toContain(PLANTED);
  });

  test("Google token endpoints", async () => {
    const messages = await observationsFrom(async (fetchImpl) => {
      const tokens = new AdcTokenSource(fetchImpl, () => 1_700_000_000_000);
      return tokens.token();
    });
    expectNoLeak(messages);
  });

  test("the Google JWKS endpoint", async () => {
    const messages = await observationsFrom(async (fetchImpl) => {
      const verifier = new GoogleIdTokenVerifier({
        audience: "aud",
        allowedEmails: ["a@b.iam.gserviceaccount.com"],
        fetchImpl,
        now: () => 1_700_000_000_000,
      });
      // A syntactically valid token so the key lookup is reached.
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com" })).toString("base64url");
      return verifier.verify(`${header}.${payload}.sig`);
    });
    expectNoLeak(messages);
  });
});
