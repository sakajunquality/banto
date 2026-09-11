import type { Fetcher } from "./types.ts";

/**
 * The two rules every outbound call in banto follows.
 *
 * **One deadline, covering the body.** A deadline that ends when the response
 * headers arrive is not a deadline: the body can stall for as long as it likes
 * afterwards, and that is the half that hurts — a stalled token body pins the
 * shared refresh promise, a stalled Cloud Run body blocks a pool's next decision, a
 * stalled runner-list body never reaches the cooldown fallback. So the only
 * primitive here performs the request *and* reads the body under one timer,
 * and aborting cancels both.
 *
 * **Do not repeat what the other end said.** Not truncated, not summarised, not
 * inside a parse error's message. Error text from a token endpoint, a proxy or
 * a captive portal can contain the credential that was just sent to it, and a
 * `JSON.parse` failure quotes the input verbatim. Errors here carry a status
 * code and a caller-supplied description. This is a discipline applied at every
 * call site, not a guarantee enforced by a type: a new call site can still
 * interpolate something it should not, which is why there is a test that plants
 * a marker in every response shape and asserts it never surfaces.
 */

export const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpError extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
  ) {
    super(`${what} failed: HTTP ${status}`);
    this.name = "HttpError";
  }
}

export class TimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`${what} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** The body, already read under the same deadline as the request. */
  text: string;
}

export async function httpRequest(
  fetchImpl: Fetcher,
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    // Still inside the timer: aborting errors the body stream, so a response
    // that stops mid-body fails here rather than hanging.
    const text = await response.text();
    return { status: response.status, ok: response.ok, headers: response.headers, text };
  } catch (error) {
    if (controller.signal.aborted) throw new TimeoutError(what, timeoutMs);
    throw new Error(`${what} failed: ${describeTransportError(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a JSON body, or fail without quoting it. */
export function parseJson<T>(response: HttpResponse, what: string): T {
  if (!response.text) return {} as T;
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new Error(`${what} returned a body that is not JSON`);
  }
}

/** Require a 2xx, then parse. The body is never read into an error message. */
export function expectJson<T>(response: HttpResponse, what: string): T {
  if (!response.ok) throw new HttpError(what, response.status);
  return parseJson<T>(response, what);
}

/**
 * Describe a transport failure without repeating anything the other end supplied.
 * Runtime error classes and errno-style codes are ours or the platform's; the
 * message text is not, so it is dropped.
 */
function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown transport error";
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code)) return code;
  // `name` is normally a runtime class name, but it is a writable property and
  // an error constructed from a response could carry anything, so it is only
  // repeated when it looks like one.
  return /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "transport error";
}
