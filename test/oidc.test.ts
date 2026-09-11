import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { signJwt } from "../src/google-auth.ts";
import { GoogleIdTokenVerifier } from "../src/oidc.ts";

// A throwaway key pair stands in for Google's signing key, so the verifier is
// exercised end to end (JWKS fetch, RS256 check, claim checks) offline.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };

const AUDIENCE = "https://banto-abc.a.run.app";
const NOW = 1_700_000_000_000;
const SCHEDULER = "banto-scheduler@my-runners-prd.iam.gserviceaccount.com";

function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const seconds = Math.floor(NOW / 1000);
  return signJwt(
    { alg: "RS256", typ: "JWT", kid: "test-key", ...header },
    {
      iss: "https://accounts.google.com",
      aud: AUDIENCE,
      sub: "1234567890",
      email: SCHEDULER,
      email_verified: true,
      iat: seconds - 10,
      exp: seconds + 3600,
      ...claims,
    },
    PEM,
  );
}

function verifier(options: { allowedEmails?: string[]; keys?: unknown[] } = {}) {
  let fetches = 0;
  const instance = new GoogleIdTokenVerifier({
    audience: AUDIENCE,
    allowedEmails: options.allowedEmails ?? [SCHEDULER],
    now: () => NOW,
    fetchImpl: async () => {
      fetches++;
      return Response.json({ keys: options.keys ?? [JWK] });
    },
  });
  return { instance, fetchCount: () => fetches };
}

describe("Google ID token verification", () => {
  test("accepts a token signed for this audience", async () => {
    const { instance } = verifier();
    const claims = await instance.verify(token());
    expect(claims.email).toBe(SCHEDULER);
    expect(claims.aud).toBe(AUDIENCE);
  });

  test("rejects a token for a different audience", async () => {
    const { instance } = verifier();
    await expect(instance.verify(token({ aud: "https://something-else" }))).rejects.toThrow("audience");
  });

  test("rejects a token from another issuer", async () => {
    const { instance } = verifier();
    await expect(instance.verify(token({ iss: "https://evil.example" }))).rejects.toThrow("issuer");
  });

  test("rejects an expired token", async () => {
    const { instance } = verifier();
    await expect(instance.verify(token({ exp: Math.floor(NOW / 1000) - 3600 }))).rejects.toThrow("expired");
  });

  test("rejects a token whose signature does not match the body", async () => {
    const { instance } = verifier();
    const [header, payload, signature] = token().split(".");
    const otherPayload = token({ sub: "999" }).split(".")[1];
    await expect(instance.verify(`${header}.${otherPayload}.${signature}`)).rejects.toThrow("signature");
  });

  test("rejects a token signed by an unknown key", async () => {
    const { instance } = verifier({ keys: [{ ...JWK, kid: "some-other-key" }] });
    await expect(instance.verify(token())).rejects.toThrow("unknown key");
  });

  test("rejects the alg=none trick", async () => {
    const [, payload] = token().split(".");
    const header = Buffer.from(JSON.stringify({ alg: "none", kid: "test-key" })).toString("base64url");
    const { instance } = verifier();
    await expect(instance.verify(`${header}.${payload}.`)).rejects.toThrow("algorithm");
  });

  test("rejects a malformed token", async () => {
    const { instance } = verifier();
    await expect(instance.verify("nonsense")).rejects.toThrow("malformed");
  });

  test("enforces the service-account allowlist when one is configured", async () => {
    const { instance } = verifier({ allowedEmails: [SCHEDULER] });
    await expect(instance.verify(token())).resolves.toBeDefined();
    await expect(instance.verify(token({ email: "someone-else@example.com" }))).rejects.toThrow("not allowed");
  });

  test("caches the key set instead of fetching it per call", async () => {
    const { instance, fetchCount } = verifier();
    await instance.verify(token());
    await instance.verify(token());
    expect(fetchCount()).toBe(1);
  });
});

describe("ID token authorization and key handling", () => {
  test("an allowlist is mandatory, because an audience is not a permission", () => {
    expect(() => new GoogleIdTokenVerifier({ audience: AUDIENCE, allowedEmails: [] })).toThrow("allowedEmails");
  });

  test("a token for the right audience from the wrong caller is refused", async () => {
    // Any Google principal can mint a token for any audience.
    const { instance } = verifier({ allowedEmails: ["someone@example.iam.gserviceaccount.com"] });
    await expect(instance.verify(token())).rejects.toThrow("not allowed");
  });

  test("an unverified email claim is refused", async () => {
    const { instance } = verifier();
    await expect(instance.verify(token({ email_verified: false }))).rejects.toThrow("not verified");
  });

  test("an email that is not positively verified is refused, not just an explicit false", async () => {
    // A missing claim must not be weaker than a wrong one. Each of these was
    // accepted while the check was `email_verified === false`.
    // `undefined` is dropped by JSON.stringify, so that case is the claim
    // being absent altogether.
    for (const value of [undefined, null, "true", "false", 0, 1]) {
      const { instance } = verifier();
      await expect(instance.verify(token({ email_verified: value }))).rejects.toThrow("not verified");
    }
  });

  test("nothing from inside an unparseable token reaches the error", async () => {
    // `/reconcile` takes a bearer token from anyone who can reach the service,
    // and the rejection is logged. `JSON.parse` quotes its input in the
    // message, so the raw error carried the caller's bytes into the log.
    const planted = "ghs_PLANTED_SECRET not json";
    const header = Buffer.from(planted).toString("base64url");
    const { instance } = verifier();
    const error = await instance.verify(`${header}.e30.sig`).catch((e: Error) => e);
    expect(String(error)).not.toContain(planted);
    expect(String(error)).not.toContain("ghs_");
  });

  test("a token with no issued-at claim is refused", async () => {
    // Skipped entirely while the check was `typeof claims.iat === "number" &&`.
    const { instance } = verifier();
    await expect(instance.verify(token({ iat: undefined }))).rejects.toThrow("no issued-at");
  });

  test("forged tokens with unknown key ids cannot be turned into traffic to Google", async () => {
    // Unthrottled, each forged kid would cost one JWKS fetch, on a route that
    // needs no credential to reach.
    const { instance, fetchCount } = verifier();
    await instance.verify(token());
    expect(fetchCount()).toBe(1);
    for (let i = 0; i < 10; i++) {
      await expect(instance.verify(token({}, { kid: `forged-${i}` }))).rejects.toThrow("unknown key");
    }
    expect(fetchCount()).toBe(1);
  });

  test("a genuinely rotated key is still picked up after the throttle window", async () => {
    let now = NOW;
    let keys = [JWK];
    let fetches = 0;
    const instance = new GoogleIdTokenVerifier({
      audience: AUDIENCE,
      allowedEmails: [SCHEDULER],
      now: () => now,
      jwksRefetchIntervalMs: 60_000,
      fetchImpl: async () => {
        fetches++;
        return Response.json({ keys });
      },
    });
    await instance.verify(token());
    expect(fetches).toBe(1);

    // Google rotates: the new kid is unknown until the throttle window passes.
    keys = [{ ...JWK, kid: "rotated" }];
    await expect(instance.verify(token({}, { kid: "rotated" }))).rejects.toThrow("unknown key");
    now += 61_000;
    await expect(instance.verify(token({}, { kid: "rotated" }))).resolves.toBeDefined();
    expect(fetches).toBe(2);
  });
});

describe("key fetching under failure", () => {
  test("a failing JWKS endpoint is throttled too, not retried per forged token", async () => {
    // The cache is empty here — a cold start, or an expired cache — which is
    // exactly when an unauthenticated caller could otherwise turn each forged
    // key id into another request to Google.
    let fetches = 0;
    const verifier = new GoogleIdTokenVerifier({
      audience: AUDIENCE,
      allowedEmails: [SCHEDULER],
      now: () => NOW,
      fetchImpl: async () => {
        fetches++;
        return new Response("service unavailable", { status: 503 });
      },
    });
    for (let i = 0; i < 3; i++) {
      await expect(verifier.verify(token({}, { kid: `forged-${i}` }))).rejects.toThrow();
    }
    expect(fetches).toBe(1);
  });

  test("the throttle lifts once the interval has passed", async () => {
    let now = NOW;
    let fetches = 0;
    let failing = true;
    const verifier = new GoogleIdTokenVerifier({
      audience: AUDIENCE,
      allowedEmails: [SCHEDULER],
      now: () => now,
      jwksRefetchIntervalMs: 60_000,
      fetchImpl: async () => {
        fetches++;
        if (failing) return new Response("unavailable", { status: 503 });
        return Response.json({ keys: [JWK] });
      },
    });
    await expect(verifier.verify(token())).rejects.toThrow();
    await expect(verifier.verify(token())).rejects.toThrow();
    expect(fetches).toBe(1);

    failing = false;
    now += 61_000;
    await expect(verifier.verify(token())).resolves.toBeDefined();
    expect(fetches).toBe(2);
  });
});
