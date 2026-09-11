import { createSign } from "node:crypto";
import { type HttpResponse, httpRequest } from "./http.ts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Fetcher } from "./types.ts";

/**
 * Application Default Credentials, in about a hundred lines of fetch.
 *
 * Why not `google-auth-library` / `@google-cloud/run`: banto makes two kinds of
 * Google call (one Cloud Run GET, one Cloud Run PATCH, plus Firestore get and
 * commit). The official clients bring gRPC, protobufjs, gax and a few hundred
 * packages for that, and this image is supposed to stay small. The token part
 * of ADC is three well-documented flows and the REST calls are plain JSON, so
 * the whole Google surface here is fetch plus the code below. If banto ever
 * needs streaming, long-running operations or IAM helpers, revisit this.
 *
 * Supported credential sources, in ADC order:
 *   1. GOOGLE_APPLICATION_CREDENTIALS pointing at a key file,
 *   2. the well-known gcloud file (`authorized_user`, for local runs),
 *   3. the metadata server (Cloud Run, GCE, GKE) — the deployment case.
 */

export interface TokenSource {
  /** A bearer token for the cloud-platform scope. */
  token(): Promise<string>;
}

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const METADATA_HOST = process.env.GCE_METADATA_HOST ?? "metadata.google.internal";
/** Refresh this many ms before the token actually expires. */
const SKEW_MS = 60_000;
/**
 * Token calls get a tighter deadline than everything else: every caller waits
 * on the shared refresh promise, so a hung one stalls the whole process.
 */
const TOKEN_TIMEOUT_MS = 5_000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class AdcTokenSource implements TokenSource {
  private cached: CachedToken | null = null;
  private inflight: Promise<CachedToken> | null = null;

  constructor(
    private readonly fetchImpl: Fetcher = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = TOKEN_TIMEOUT_MS,
  ) {}

  async token(): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAt - SKEW_MS > this.now()) return cached.value;
    // Collapse concurrent refreshes so a burst of webhooks mints one token.
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    const fresh = await this.inflight;
    this.cached = fresh;
    return fresh.value;
  }

  private async refresh(): Promise<CachedToken> {
    const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (explicit) return this.fromKeyFile(explicit);

    const wellKnown = wellKnownCredentialsPath();
    let contents: string | null = null;
    try {
      contents = await readFile(wellKnown, "utf8");
    } catch (error) {
      // "No such file" is the ordinary case on Cloud Run: fall through to the
      // metadata server. A file that exists but cannot be read is a different
      // thing — silently running as a different identity is worse than failing.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`reading ${wellKnown} failed: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`);
      }
    }
    if (contents !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch {
        throw new Error(`${wellKnown} is not valid JSON`);
      }
      return this.fromCredentials(parsed as Record<string, unknown>, wellKnown);
    }

    return this.fromMetadataServer();
  }

  private async fromKeyFile(path: string): Promise<CachedToken> {
    const contents = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error(`${path} is not valid JSON`);
    }
    return this.fromCredentials(parsed as Record<string, unknown>, path);
  }

  private async fromCredentials(creds: Record<string, unknown>, origin: string): Promise<CachedToken> {
    if (creds.type === "service_account") return this.fromServiceAccount(creds);
    if (creds.type === "authorized_user") return this.fromAuthorizedUser(creds);
    throw new Error(`unsupported credential type in ${origin}: ${String(creds.type)}`);
  }

  /** Self-signed JWT assertion grant (RFC 7523), the service-account flow. */
  private async fromServiceAccount(creds: Record<string, unknown>): Promise<CachedToken> {
    const clientEmail = String(creds.client_email ?? "");
    const privateKey = String(creds.private_key ?? "");
    const tokenUri = String(creds.token_uri ?? "https://oauth2.googleapis.com/token");
    if (!clientEmail || !privateKey) throw new Error("service account credentials are missing client_email/private_key");

    const issuedAt = Math.floor(this.now() / 1000);
    const assertion = signJwt(
      { alg: "RS256", typ: "JWT" },
      { iss: clientEmail, scope: SCOPE, aud: tokenUri, iat: issuedAt, exp: issuedAt + 3600 },
      privateKey,
    );
    const response = await httpRequest(
      this.fetchImpl,
      tokenUri,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      },
      "service account token exchange",
      this.timeoutMs,
    );
    return this.readTokenResponse(response, "service account token exchange");
  }

  /** Refresh-token grant, what `gcloud auth application-default login` leaves behind. */
  private async fromAuthorizedUser(creds: Record<string, unknown>): Promise<CachedToken> {
    const response = await httpRequest(
      this.fetchImpl,
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: String(creds.client_id ?? ""),
          client_secret: String(creds.client_secret ?? ""),
          refresh_token: String(creds.refresh_token ?? ""),
        }),
      },
      "user credential refresh",
      this.timeoutMs,
    );
    return this.readTokenResponse(response, "user credential refresh");
  }

  private async fromMetadataServer(): Promise<CachedToken> {
    const url = `http://${METADATA_HOST}/computeMetadata/v1/instance/service-accounts/default/token`;
    const response = await httpRequest(
      this.fetchImpl,
      url,
      { headers: { "Metadata-Flavor": "Google" } },
      "metadata server token",
      this.timeoutMs,
    );
    return this.readTokenResponse(response, "metadata server token");
  }

  private readTokenResponse(response: HttpResponse, what: string): CachedToken {
    if (!response.ok) {
      // Deliberately does not include the body: token endpoints echo back
      // assertions and client secrets in some error shapes.
      throw new Error(`${what} failed with HTTP ${response.status}`);
    }
    let body: { access_token?: string; expires_in?: number };
    try {
      body = JSON.parse(response.text) as { access_token?: string; expires_in?: number };
    } catch {
      // A parse error would carry the response text, and on this path the
      // response text is (or contains) a credential.
      throw new Error(`${what} returned a body that is not JSON`);
    }
    if (!body.access_token) throw new Error(`${what} returned no access_token`);
    // A zero or missing lifetime would hand back an already-expired token and
    // send every request into a refresh loop; treat it as the standard hour.
    const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    return { value: body.access_token, expiresAt: this.now() + lifetime * 1000 };
  }
}

export function wellKnownCredentialsPath(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? "", "gcloud", "application_default_credentials.json");
  }
  return join(homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/** RS256 JWT. Used for the service-account ADC flow and by the GitHub App client. */
export function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKeyPem: string,
): string {
  const encode = (value: unknown) => base64url(Buffer.from(JSON.stringify(value), "utf8"));
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  // node:crypto accepts both PKCS#1 ("BEGIN RSA PRIVATE KEY", what GitHub
  // hands out) and PKCS#8; WebCrypto would only take the latter.
  const signature = signer.sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

export function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** A fixed token, for tests and for local runs against a fake. */
export function staticTokenSource(value: string): TokenSource {
  return { token: async () => value };
}
