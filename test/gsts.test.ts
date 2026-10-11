import { expect, test } from "bun:test";
import { GstsTokenSource } from "../src/gsts.ts";
import { GitHubAppClient } from "../src/github.ts";
import { loadConfig } from "../src/config.ts";
import { pool } from "./helpers.ts";

const now = 1_700_000_000_000;
const options = { url: "https://gsts.example", audience: "https://gsts.identity", scope: "example/infra", identity: "controller-prd" };
const env = {
  GSTS_URL: options.url, GSTS_AUDIENCE: options.audience, GSTS_SCOPE: options.scope, GSTS_IDENTITY: options.identity,
  GH_APP_INSTALLATION_ID: "123", GITHUB_WEBHOOK_SECRET: "unused", BANTO_GCS_BUCKET: "state-bucket",
  BANTO_POOLS: JSON.stringify([{ name: "runner", backend: "jobs", project: "test-project", location: "us-central1",
    job: "runner", max: 1, labels: ["canary"], runnerRepo: "example/infra" }]),
  BANTO_RECONCILE_AUDIENCE: "https://controller.example", BANTO_RECONCILE_ALLOWED_EMAILS: "scheduler@test-project.iam.gserviceaccount.com",
};

test("gsts mode starts without any App key and rejects mixed or incomplete credentials", () => {
  expect(loadConfig(env).github.gsts).toEqual(options);
  for (const key of ["GSTS_URL", "GSTS_AUDIENCE", "GSTS_SCOPE", "GSTS_IDENTITY"]) {
    expect(() => loadConfig({ ...env, [key]: "" })).toThrow(`${key} is required`);
  }
  expect(() => loadConfig({ ...env, GH_APP_PRIVATE_KEY: "secret" })).toThrow("cannot be combined");
  for (const url of ["http://gsts.example", "https://user:secret@gsts.example", "https://gsts.example/?secret=x"]) {
    expect(() => loadConfig({ ...env, GSTS_URL: url })).toThrow("HTTPS URL");
  }
  expect(() => loadConfig({ ...env, GSTS_IDENTITY: "../prd" })).toThrow("policy name");
});

test("controller exchanges its Google identity and caches only the returned scoped token", async () => {
  let exchanges = 0;
  let clock = now;
  const source = new GstsTokenSource(options, async (input, init) => {
    const url = new URL(String(input));
    expect(init?.redirect).toBe("error");
    if (url.hostname === "metadata.google.internal") {
      expect(url.searchParams.get("audience")).toBe(options.audience);
      expect(new Headers(init?.headers).get("Metadata-Flavor")).toBe("Google");
      return new Response("header.payload.signature");
    }
    exchanges++;
    expect(url.href).toBe("https://gsts.example/token");
    expect(JSON.parse(String(init?.body))).toEqual({ scope: options.scope, identity: options.identity });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer header.payload.signature");
    expect(headers.get("x-serverless-authorization")).toBe(headers.get("authorization"));
    return Response.json({ token: "scoped-installation", expires_at: new Date(clock + 3_600_000).toISOString() });
  }, () => clock);
  const client = new GitHubAppClient({ installationId: "123", org: "example", tokenSource: source, now: () => clock,
    fetchImpl: async (input, init) => {
      expect(String(input)).not.toContain("access_tokens");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer scoped-installation");
      return Response.json({ runner: { id: 1 }, encoded_jit_config: "single-job" });
    } });
  await Promise.all([client.createJitRunner(pool(), "one"), client.createJitRunner(pool(), "two")]);
  expect(exchanges).toBe(1);
  clock += 3_550_000;
  await client.createJitRunner(pool(), "three");
  expect(exchanges).toBe(2);
});

test("denials and malformed token responses fail closed without echoing credentials", async () => {
  for (const response of [new Response("SENSITIVE", { status: 403 }), new Response("SENSITIVE"),
    Response.json(null), Response.json({ token: "SENSITIVE", expires_at: new Date(now - 1).toISOString() })]) {
    const source = new GstsTokenSource(options, async (input) => String(input).includes("metadata.google.internal")
      ? new Response("header.payload.signature") : response, () => now);
    const error = await source.mint().then(() => null, (error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain("SENSITIVE");
  }
});
