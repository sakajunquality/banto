/**
 * Verification of the Google-signed OIDC ID token Cloud Scheduler sends to
 * `/reconcile`.
 *
 * Why banto verifies the token itself instead of leaning on Cloud Run IAM:
 * `/webhook` has to be reachable by GitHub, which carries no Google identity,
 * so the service must be deployed with `--allow-unauthenticated`. Cloud Run IAM
 * is a property of the service, not of a path — once the service is public,
 * every path on it is. The only place left to check who is calling `/reconcile`
 * is inside the process.
 *
 * (Splitting this into two Cloud Run services sharing one store — a public one
 * for `/webhook`, a private one for `/reconcile` — looks like an alternative
 * and is not one: both would still mount both routes. The README says why.)
 *
 * The check: RS256 over Google's published JWKS, `iss` one of Google's two
 * spellings, `aud` equal to the configured audience, `exp` and `iat` both
 * present and within a small skew, `email_verified` exactly `true`, and the
 * caller's service-account email on the allowlist. None of it is optional.
 */

import { httpRequest } from "./http.ts";
import type { Fetcher } from "./types.ts";

export interface VerifiedIdToken {
  sub: string;
  email?: string;
  aud: string;
}

export interface TokenVerifier {
  /** Resolves with the claims, or throws with the reason it was rejected. */
  verify(token: string): Promise<VerifiedIdToken>;
}

export interface GoogleIdTokenVerifierOptions {
  audience: string;
  /**
   * Service-account emails allowed to call. Required and non-empty: an audience
   * is a name, not a permission, and any Google principal can mint a token for
   * any audience. Without an allowlist, "verified" would mean nothing more than
   * "signed by Google".
   */
  allowedEmails: string[];
  jwksUri?: string;
  fetchImpl?: Fetcher;
  now?: () => number;
  clockSkewSeconds?: number;
  /** How long a fetched key set is reused. */
  jwksTtlMs?: number;
  /** Shortest interval between JWKS fetches provoked by an unknown `kid`. */
  jwksRefetchIntervalMs?: number;
  timeoutMs?: number;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
  use?: string;
}

export class GoogleIdTokenVerifier implements TokenVerifier {
  private readonly jwksUri: string;
  private readonly fetchImpl: Fetcher;
  private readonly now: () => number;
  private readonly skew: number;
  private readonly ttl: number;
  private readonly refetchInterval: number;
  private readonly timeoutMs: number;
  private keys: { fetchedAt: number; byKid: Map<string, Jwk> } | null = null;
  private lastFetchAttempt = 0;
  private inflight: Promise<Map<string, Jwk>> | null = null;

  constructor(private readonly options: GoogleIdTokenVerifierOptions) {
    if (options.allowedEmails.length === 0) {
      throw new Error("GoogleIdTokenVerifier requires a non-empty allowedEmails list");
    }
    this.jwksUri = options.jwksUri ?? "https://www.googleapis.com/oauth2/v3/certs";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.skew = options.clockSkewSeconds ?? 60;
    this.ttl = options.jwksTtlMs ?? 60 * 60 * 1000;
    this.refetchInterval = options.jwksRefetchIntervalMs ?? 5 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async verify(token: string): Promise<VerifiedIdToken> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed ID token");
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

    const header = decodeJson(headerPart) as { alg?: string; kid?: string };
    // The algorithm and issuer come out of an unauthenticated token, so they
    // are named as facts about the check, never quoted back.
    if (header.alg !== "RS256") throw new Error("ID token algorithm is not RS256");
    if (!header.kid) throw new Error("ID token has no kid");

    const jwk = await this.keyFor(header.kid);
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("ID token signing key is not an RSA JWK");
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64urlDecode(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!ok) throw new Error("ID token signature is invalid");

    const claims = decodeJson(payloadPart) as {
      iss?: string;
      aud?: string;
      exp?: number;
      iat?: number;
      sub?: string;
      email?: string;
      email_verified?: boolean;
    };

    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
      throw new Error("ID token issuer is not Google");
    }
    if (claims.aud !== this.options.audience) throw new Error("ID token audience mismatch");

    const nowSeconds = Math.floor(this.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp + this.skew < nowSeconds) {
      throw new Error("ID token has expired");
    }
    // Required, not "checked when present": a claim that is absent must not be
    // weaker than one that is wrong. Google issues both of these on every ID
    // token, so demanding them rejects nothing legitimate.
    if (typeof claims.iat !== "number") throw new Error("ID token has no issued-at claim");
    if (claims.iat - this.skew > nowSeconds) throw new Error("ID token is not valid yet");

    // Authorization, separate from authentication: a valid Google token says
    // who is calling, not that they may. `email_verified` must be exactly
    // `true` — absent, or any other value, is not a verified address.
    if (claims.email_verified !== true) throw new Error("ID token email is not verified");
    if (!claims.email || !this.options.allowedEmails.includes(claims.email)) {
      throw new Error("ID token caller is not allowed");
    }

    const result: VerifiedIdToken = { sub: String(claims.sub ?? ""), aud: claims.aud };
    if (claims.email) result.email = claims.email;
    return result;
  }

  /**
   * Resolve a signing key, refetching the key set at most every
   * `jwksRefetchIntervalMs`.
   *
   * The throttle matters because this route is public: an unknown `kid` costs
   * nothing to forge, and an unthrottled cache miss would let anyone turn one
   * unauthenticated request into one request to Google. Concurrent refetches
   * share a single promise for the same reason.
   */
  private async keyFor(kid: string): Promise<Jwk> {
    const cached = this.keys;
    if (cached !== null && this.now() - cached.fetchedAt < this.ttl) {
      const hit = cached.byKid.get(kid);
      if (hit) return hit;
    }

    // A fetch already running answers this caller too: concurrent requests must
    // not each start their own, and the throttle below is checked only when
    // there is nothing to join.
    let pending = this.inflight;
    if (!pending) {
      // Throttle every fetch this path can provoke, not just the ones behind a
      // warm cache: a cold start, an expired cache and a failing JWKS endpoint
      // all leave the cache empty, and that is exactly when an unauthenticated
      // caller could turn forged key ids into traffic to Google.
      if (this.lastFetchAttempt !== 0 && this.now() - this.lastFetchAttempt < this.refetchInterval) {
        throw new Error("ID token was signed by an unknown key");
      }
      pending = this.fetchKeys().finally(() => {
        this.inflight = null;
      });
      this.inflight = pending;
    }
    const byKid = await pending;
    const jwk = byKid.get(kid);
    if (!jwk) throw new Error("ID token was signed by an unknown key");
    return jwk;
  }

  private async fetchKeys(): Promise<Map<string, Jwk>> {
    this.lastFetchAttempt = this.now();
    const response = await httpRequest(
      this.fetchImpl,
      this.jwksUri,
      { headers: { accept: "application/json" } },
      "fetching Google JWKS",
      this.timeoutMs,
    );
    if (!response.ok) throw new Error(`fetching Google JWKS failed: HTTP ${response.status}`);
    let body: { keys?: Jwk[] };
    try {
      body = JSON.parse(response.text) as { keys?: Jwk[] };
    } catch {
      throw new Error("Google JWKS response was not JSON");
    }
    const byKid = new Map<string, Jwk>();
    for (const key of body.keys ?? []) if (key.kid) byKid.set(key.kid, key);
    this.keys = { fetchedAt: this.now(), byKid };
    return byKid;
  }
}

function decodeJson(part: string): unknown {
  // `JSON.parse` quotes the offending input in its message, and this input is
  // an unauthenticated bearer token: whatever an anonymous caller put in it
  // would travel through the thrown error into the request log. Say only that
  // it did not parse.
  try {
    return JSON.parse(new TextDecoder().decode(base64urlDecode(part)));
  } catch {
    throw new Error("ID token segment is not valid JSON");
  }
}

function base64urlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(Buffer.from(padded, "base64"));
}
