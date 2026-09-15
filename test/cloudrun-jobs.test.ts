import { describe, expect, test } from "bun:test";
import { CloudRunJobsClient } from "../src/cloudrun-jobs.ts";
import { staticTokenSource } from "../src/google-auth.ts";
import { pool } from "./helpers.ts";

const config = pool({ backend: "jobs", job: "runner", idleTimeoutSeconds: 120 });
const root = "projects/test-project/locations/asia-northeast1";
const jobName = `${root}/jobs/runner`;
const executionName = `${jobName}/executions/runner-one`;
const operationName = `${root}/operations/one`;
const launch = { id: "00000000-0000-4000-8000-000000000001", createdAt: 1_700_000_000_000 };
const template = () => ({ name: jobName, etag: "version", template: { taskCount: 1,
  template: { timeout: "3600s", maxRetries: 0, containers: [{ name: "runner" }] } } });
const execution = () => ({ name: executionName, taskCount: 1, template: { containers: [{ name: "runner",
  env: [{ name: "BANTO_LAUNCH_ID", value: launch.id }, { name: "BANTO_JIT_CONFIG", value: "sensitive" }] }] } });

describe("Cloud Run runner executions", () => {
  test("uses an etag, one task, and per-execution JIT overrides", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const client = new CloudRunJobsClient(staticTokenSource("token"), async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json(init?.method === "POST" ? { name: operationName, metadata: { name: executionName } } : template());
    });
    expect(await client.start(config, launch, "one-job-secret")).toEqual({ operation: operationName, execution: executionName });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(`https://asia-northeast1-run.googleapis.com/v2/${jobName}:run`);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ etag: "version", overrides: { taskCount: 1,
      containerOverrides: [{ name: "runner", env: [
        { name: "BANTO_LAUNCH_ID", value: launch.id }, { name: "BANTO_JIT_CONFIG", value: "one-job-secret" },
        { name: "BANTO_RUNNER_IDLE_SECONDS", value: "120" },
      ] }] } });
  });

  test("never retries an ambiguous run POST", async () => {
    let posts = 0;
    const client = new CloudRunJobsClient(staticTokenSource("token"), async (_input, init) => {
      if (init?.method !== "POST") return Response.json(template());
      posts++; throw new Error("sensitive transport content");
    });
    await expect(client.start(config, launch, "secret")).rejects.toThrow("Cloud Run Jobs POST failed");
    expect(posts).toBe(1);
  });

  for (const [name, change] of [
    ["retrying template", (v: any) => { v.template.template.maxRetries = 3; }],
    ["multiple tasks", (v: any) => { v.template.taskCount = 2; }],
    ["missing etag", (v: any) => { delete v.etag; }],
    ["short timeout", (v: any) => { v.template.template.timeout = "60s"; }],
    ["wrong container", (v: any) => { v.template.template.containers[0].name = "other"; }],
    ["sidecar", (v: any) => { v.template.template.containers.push({ name: "sidecar" }); }],
    ["different job", (v: any) => { v.name = `${root}/jobs/other`; }],
  ] as const) {
    test(`rejects ${name} before POST`, async () => {
      let posts = 0;
      const value = template(); change(value);
      const client = new CloudRunJobsClient(staticTokenSource("token"), async (_input, init) => {
        if (init?.method === "POST") posts++;
        return Response.json(value);
      });
      await expect(client.start(config, launch, "secret")).rejects.toThrow();
      expect(posts).toBe(0);
    });
  }

  test("resolves a canonical project number from the configured job GET", async () => {
    const canonical = executionName.replace("test-project", "123456789012");
    const client = new CloudRunJobsClient(staticTokenSource("token"), async (input) => {
      if (String(input).endsWith("/jobs/runner")) return Response.json({ ...template(), name: jobName.replace("test-project", "123456789012") });
      return Response.json({ ...execution(), name: canonical, completionTime: "2026-09-16T01:00:00Z", succeededCount: 1 });
    });
    expect(await client.observe(config, { ...launch, execution: canonical })).toMatchObject({ terminal: true, failed: false });
  });

  test("terminal execution parsing exposes no JIT credentials", async () => {
    const client = new CloudRunJobsClient(staticTokenSource("token"), async (input) => Response.json(
      String(input).endsWith("/jobs/runner") ? template() : { ...execution(), completionTime: "2026-09-16T01:00:00Z", failedCount: 1 },
    ));
    const result = await client.observe(config, { ...launch, execution: executionName });
    expect(result).toEqual({ name: executionName, launchId: launch.id, terminal: true, failed: true });
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  test("follows an operation to its execution", async () => {
    const client = new CloudRunJobsClient(staticTokenSource("token"), async (input) => {
      const url = String(input);
      return Response.json(url.endsWith("/jobs/runner") ? template() : url.endsWith("/operations/one") ?
        { metadata: { name: executionName } } : execution());
    });
    expect(await client.observe(config, { ...launch, operation: operationName })).toMatchObject({ name: executionName, terminal: false });
  });

  test("does not follow a stored resource outside the configured job", async () => {
    let calls = 0;
    const client = new CloudRunJobsClient(staticTokenSource("token"), async () => { calls++; return Response.json(template()); });
    await expect(client.observe(config, { ...launch, execution: executionName.replace("/jobs/runner/", "/jobs/other/") })).rejects.toThrow("out-of-scope");
    expect(calls).toBe(1);
  });

  test("discovers a lost response on a later page without treating absence as completion", async () => {
    const client = new CloudRunJobsClient(staticTokenSource("token"), async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/jobs/runner")) return Response.json(template());
      return Response.json(url.searchParams.has("pageToken") ? { executions: [execution()] } : { nextPageToken: "page2" });
    });
    expect(await client.find(config, [launch.id])).toHaveLength(1);
    expect(await client.find(config, ["absent"])).toEqual([]);
  });

  for (const response of ["sensitive-not-json", JSON.stringify({ name: operationName, done: true, error: { message: "sensitive" } })]) {
    test("errors never repeat response credentials", async () => {
      const client = new CloudRunJobsClient(staticTokenSource("token"), async (_input, init) =>
        init?.method === "POST" ? new Response(response) : Response.json(template()));
      let message = "";
      try { await client.start(config, launch, "sensitive"); } catch (error) { message = String(error); }
      expect(message).not.toBe("");
      expect(message).not.toContain("sensitive");
    });
  }
});
