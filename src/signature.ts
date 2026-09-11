import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify GitHub's `X-Hub-Signature-256` header: HMAC-SHA256 of the raw request
 * body, keyed with the webhook secret, rendered as `sha256=<hex>`.
 *
 * The body must be the bytes GitHub sent. Decoding it to a string and encoding
 * it back is not a round trip: any byte sequence that is not valid UTF-8 comes
 * back as U+FFFD, so two different bodies can hash the same and a payload with
 * bytes substituted would verify against the original signature. Everything
 * here works on `Uint8Array`; the string overload exists for tests.
 *
 * The comparison is constant time. Everything that is not exactly one valid
 * signature over these bytes is a rejection: a missing header, the wrong
 * prefix, a truncated digest, a body that was rewritten in flight.
 */
export function verifySignature(
  secret: string,
  body: Uint8Array | string,
  header: string | null | undefined,
): boolean {
  if (!header) return false;
  const expected = signBody(secret, body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length; compare lengths first and still run the constant-time compare.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `sha256=<hex>` for a body. Exported for tests and for nothing else. */
export function signBody(secret: string, body: Uint8Array | string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body));
  return `sha256=${hmac.digest("hex")}`;
}
