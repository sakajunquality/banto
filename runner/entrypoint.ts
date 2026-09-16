import { mkdtemp, rm, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

/** The idle deadline is a mitigation: assignment can precede the start hook. */
export async function runRunner(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const jit = env.BANTO_JIT_CONFIG;
  const idleSeconds = Number(env.BANTO_RUNNER_IDLE_SECONDS ?? "120");
  if (!jit || !Number.isSafeInteger(idleSeconds) || idleSeconds < 1 || idleSeconds > 3600) {
    console.error("runner requires JIT configuration and an idle timeout of 1-3600 seconds");
    return 78;
  }
  const directory = await mkdtemp(join(tmpdir(), "banto-runner-"));
  const startedFile = join(directory, "started");
  const childEnv: NodeJS.ProcessEnv = { ...env, BANTO_JOB_STARTED_FILE: startedFile,
    ACTIONS_RUNNER_HOOK_JOB_STARTED: join(dirname(import.meta.path), "job-started.sh") };
  // GitHub runner receives only its own one-job configuration. Never forward
  // the administrative App key through this image or its deployment template.
  delete childEnv.BANTO_JIT_CONFIG;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([join(env.BANTO_RUNNER_DIR ?? "/home/runner", "run.sh"), "--jitconfig", jit], {
      cwd: env.BANTO_RUNNER_DIR ?? "/home/runner", env: childEnv,
      stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
  } catch {
    await rm(directory, { recursive: true, force: true });
    console.error("could not start runner listener");
    return 1;
  }
  let idle = false;
  let finished = false;
  const timer = setTimeout(async () => {
    try { await access(startedFile); }
    catch {
      if (finished) return;
      idle = true;
      console.info("runner idle deadline reached; stopping unassigned listener");
      if (child.exitCode === null) child.kill("SIGINT");
    }
  }, idleSeconds * 1000);
  const stop = () => { if (!finished && child.exitCode === null) child.kill("SIGINT"); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const code = await child.exited;
    return idle ? 0 : code;
  } finally {
    finished = true;
    clearTimeout(timer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await runRunner());
