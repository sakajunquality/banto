import { expect, test } from "bun:test";
import { runRunner } from "../runner/entrypoint.ts";
import { join } from "node:path";

const env = (mode: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", BANTO_JIT_CONFIG: "one-job-secret",
  BANTO_RUNNER_IDLE_SECONDS: "1", BANTO_RUNNER_DIR: join(import.meta.dir, "fixtures", "runner"), BANTO_TEST_MODE: mode });

test("the idle deadline stops an unused runner and exits successfully", async () => {
  expect(await runRunner(env("idle"))).toBe(0);
});
test("the job-start hook disables the idle deadline without hiding the listener exit code", async () => {
  expect(await runRunner(env("busy"))).toBe(23);
});
test("runner startup failures remain failures for launch backoff", async () => {
  expect(await runRunner(env("failure"))).toBe(13);
});
test("missing JIT credentials fail before spawning a runner", async () => {
  expect(await runRunner({ BANTO_RUNNER_IDLE_SECONDS: "1" })).toBe(78);
});
