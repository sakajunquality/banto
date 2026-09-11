import { Hono } from "hono";
import { Controller, errorMessage } from "./controller.ts";
import type { Logger } from "./log.ts";
import type { TokenVerifier } from "./oidc.ts";
import { verifySignature } from "./signature.ts";
import type { WorkflowJobEvent } from "./types.ts";

export interface ServerDeps {
  controller: Controller;
  webhookSecret: string;
  logger: Logger;
  /**
   * Always present: the webhook makes this service public, so nothing outside
   * the process can protect `/reconcile`.
   */
  reconcileVerifier: TokenVerifier;
  /**
   * The installation whose events banto acts on. A signature proves the event
   * came from the App; it does not say which installation of that App.
   */
  installationId: string;
  /** Optional `owner/repo` allowlist; empty accepts any repo of the installation. */
  allowedRepositories?: string[];
  /** Largest webhook body accepted, in bytes. */
  maxBodyBytes?: number;
  /** Deadline for reading a request body. */
  bodyTimeoutMs?: number;
}

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;

export function createApp(deps: ServerDeps) {
  const app = new Hono();
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const bodyTimeoutMs = deps.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const allowedRepositories = new Set((deps.allowedRepositories ?? []).map((repo) => repo.toLowerCase()));

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.post("/webhook", async (c) => {
    // Cheapest rejections first, before any body is read: an unsigned request
    // should not be able to make banto buffer megabytes.
    const signature = c.req.header("x-hub-signature-256");
    if (!signature) {
      deps.logger.warn("rejected unsigned webhook", { event: c.req.header("x-github-event") ?? null });
      return c.json({ error: "missing signature" }, 401);
    }
    const declaredLength = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return c.json({ error: "payload too large" }, 413);
    }

    let raw: Uint8Array;
    try {
      raw = await readBody(c.req.raw, maxBodyBytes, bodyTimeoutMs);
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError;
      const timedOut = error instanceof BodyTimeoutError;
      deps.logger.warn("rejected webhook body", {
        reason: tooLarge ? "too_large" : timedOut ? "timed_out" : "read_failed",
      });
      if (tooLarge) return c.json({ error: "payload too large" }, 413);
      if (timedOut) return c.json({ error: "body read timed out" }, 408);
      return c.json({ error: "could not read body" }, 400);
    }

    // The signature covers the bytes GitHub sent, so it is checked against
    // those bytes — never against text that has been decoded and re-encoded.
    if (!verifySignature(deps.webhookSecret, raw, signature)) {
      deps.logger.warn("rejected webhook with bad signature", {
        event: c.req.header("x-github-event") ?? null,
        delivery: c.req.header("x-github-delivery") ?? null,
      });
      return c.json({ error: "invalid signature" }, 401);
    }

    const eventName = c.req.header("x-github-event");
    if (eventName === "ping") return c.json({ status: "pong" });
    if (eventName !== "workflow_job") {
      return c.json({ status: "ignored", reason: "unsupported_event", event: eventName ?? null }, 202);
    }

    let payload: WorkflowJobEvent;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw)) as WorkflowJobEvent;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof payload?.workflow_job?.id !== "number") {
      return c.json({ error: "payload is not a workflow_job event" }, 400);
    }

    // A valid signature says "this came from the App", not "this is your
    // installation". A public App can be installed by anyone, and GitHub signs
    // every installation's events with the same webhook secret — so without
    // this check, a stranger's CI would scale the operator's pools.
    const installationId = payload.installation?.id;
    if (String(installationId ?? "") !== deps.installationId) {
      deps.logger.warn("rejected webhook from another installation", {
        installation: installationId ?? null,
        delivery: c.req.header("x-github-delivery") ?? null,
      });
      return c.json({ error: "unknown installation" }, 403);
    }

    const repository = payload.repository?.full_name ?? "";
    if (allowedRepositories.size > 0 && !allowedRepositories.has(repository.toLowerCase())) {
      deps.logger.warn("rejected webhook from a repository outside the allowlist", { repository });
      return c.json({ error: "repository not allowed" }, 403);
    }

    try {
      // Handled inline, so a 2xx is a promise that the decision was made
      // rather than that it was queued. The work is a set of GitHub listings,
      // a store round trip and at most one Cloud Run call — bounded by the
      // installation's size, not by this route, which is why the server sets
      // its own idle timeout rather than taking Bun's 10s default. GitHub
      // gives a delivery 10s before it records a timeout, and does *not*
      // redeliver on its own — a delivery lost that way is recovered by the
      // scheduled reconcile, not by GitHub. Nothing here depends on a retry.
      const outcome = await deps.controller.handleWorkflowJob(payload);
      return c.json(outcome);
    } catch (error) {
      // 500 so GitHub's redelivery is available; the reconcile would catch it
      // anyway, but an earlier retry is cheaper than a later correction.
      deps.logger.error("webhook handling failed", {
        delivery: c.req.header("x-github-delivery") ?? null,
        error: errorMessage(error),
      });
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.post("/reconcile", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) return c.json({ error: "missing bearer token" }, 401);
    try {
      const claims = await deps.reconcileVerifier.verify(token);
      deps.logger.debug("reconcile caller verified", { caller: claims.email ?? claims.sub });
    } catch (error) {
      deps.logger.warn("rejected reconcile call", { error: errorMessage(error) });
      return c.json({ error: "unauthorized" }, 401);
    }

    try {
      const result = await deps.controller.reconcile();
      if (result.failures.length > 0) {
        // A 200 here would tell Cloud Scheduler the run succeeded and there
        // would be no retry, even when every pool failed.
        return c.json({ status: "partial_failure", ...result }, 500);
      }
      return c.json({ status: "ok", ...result });
    } catch (error) {
      deps.logger.error("reconcile failed", { error: errorMessage(error) });
      return c.json({ error: "internal error" }, 500);
    }
  });

  return app;
}

class BodyTooLargeError extends Error {}
class BodyTimeoutError extends Error {}

/**
 * Read a request body with a byte cap and a deadline.
 *
 * `Request.arrayBuffer()` has neither: a slow trickle of bytes from an
 * unauthenticated caller would otherwise hold a connection and a buffer for as
 * long as it liked. The cap is enforced as chunks arrive, not after.
 */
async function readBody(request: Request, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  const body = request.body;
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      // Cancelling a reader makes the next read report `done`, which would
      // otherwise pass a truncated body off as a complete one.
      if (timedOut) throw new BodyTimeoutError(`body not received within ${timeoutMs}ms`);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(`body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    if (timedOut) throw new BodyTimeoutError(`body not received within ${timeoutMs}ms`);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}
