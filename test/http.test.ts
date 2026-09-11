import { describe, expect, test } from "bun:test";
import { expectJson, HttpError, httpRequest, parseJson, TimeoutError } from "../src/http.ts";
import type { Fetcher } from "../src/types.ts";

const PLANTED = "ghs_PLANTED_SECRET";

describe("outbound request discipline", () => {
  test("a request that never settles fails on its deadline", async () => {
    const hang: Fetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(httpRequest(hang, "https://example.test", {}, "hanging call", 20)).rejects.toThrow(TimeoutError);
  });

  test("the deadline covers the body, not just the headers", async () => {
    // Headers arriving promptly and a body that never finishes is the shape
    // that used to escape the timer entirely: the response resolved, the timer
    // was cleared, and the read hung forever.
    const stalledBody: Fetcher = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(body, { status: 200 });
    };
    const started = Date.now();
    await expect(httpRequest(stalledBody, "https://example.test", {}, "stalled body", 50)).rejects.toThrow(
      TimeoutError,
    );
    // Comfortably inside a multiple of the deadline, i.e. the abort really fired.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("the deadline is passed down as an abort signal", async () => {
    let sawSignal = false;
    const probe: Fetcher = async (_url, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return Response.json({});
    };
    await httpRequest(probe, "https://example.test", {}, "probe", 1_000);
    expect(sawSignal).toBe(true);
  });

  test("a transport failure is reported by code or class, never by message", async () => {
    const broken: Fetcher = async () => {
      const error = new Error(`connect failed while sending ${PLANTED}`) as NodeJS.ErrnoException;
      error.code = "ECONNRESET";
      throw error;
    };
    const error = await httpRequest(broken, "https://example.test", {}, "call", 100).catch((e: unknown) => e);
    expect(String(error)).toContain("ECONNRESET");
    expect(String(error)).not.toContain(PLANTED);
  });

  test("a transport failure with no code degrades to the error class", async () => {
    const broken: Fetcher = async () => {
      throw new TypeError(`fetch failed for ${PLANTED}`);
    };
    const error = await httpRequest(broken, "https://example.test", {}, "call", 100).catch((e: unknown) => e);
    expect(String(error)).toContain("TypeError");
    expect(String(error)).not.toContain(PLANTED);
  });

  test("an error response is reported by status, never by body", async () => {
    const response = { status: 401, ok: false, headers: new Headers(), text: `Bearer ${PLANTED} rejected` };
    const error = await Promise.resolve()
      .then(() => expectJson(response, "token call"))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(String(error)).toContain("HTTP 401");
    expect(String(error)).not.toContain(PLANTED);
  });

  test("an unparseable body does not quote it either", async () => {
    const response = { status: 200, ok: true, headers: new Headers(), text: `${PLANTED} is not JSON` };
    const error = await Promise.resolve()
      .then(() => parseJson(response, "token call"))
      .catch((e: unknown) => e);
    expect(String(error)).toContain("not JSON");
    expect(String(error)).not.toContain(PLANTED);
  });
});
