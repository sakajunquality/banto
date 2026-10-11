import { expectJson, httpRequest } from "./http.ts";
import type { Fetcher } from "./types.ts";

export interface InstallationCredential {
  value: string;
  expiresAt: number;
}

export interface InstallationTokenSource {
  mint(): Promise<InstallationCredential>;
}

export interface GstsOptions {
  url: string;
  audience: string;
  scope: string;
  identity: string;
}

/** Only the controller's identity is authorized by the default-branch policy.
 * No App signing key or installation token is ever sent to a runner. */
export class GstsTokenSource implements InstallationTokenSource {
  constructor(
    private readonly options: GstsOptions,
    private readonly fetchImpl: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async mint(): Promise<InstallationCredential> {
    const metadata = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
    metadata.searchParams.set("audience", this.options.audience);
    metadata.searchParams.set("format", "full");
    const identity = await httpRequest(this.fetchImpl, metadata.href, {
      headers: { "Metadata-Flavor": "Google" }, redirect: "error",
    }, "gsts caller identity", 5_000);
    if (!identity.ok || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(identity.text)) {
      throw new Error("gsts caller identity unavailable");
    }
    const response = await httpRequest(this.fetchImpl, `${this.options.url.replace(/\/$/, "")}/token`, {
      method: "POST", redirect: "error",
      headers: {
        authorization: `Bearer ${identity.text}`,
        // Cloud Run validates this header and leaves Authorization intact for
        // gsts's independent signature verification. Configure a custom audience.
        "x-serverless-authorization": `Bearer ${identity.text}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: this.options.scope, identity: this.options.identity }),
    }, "gsts token exchange");
    const body = expectJson<{ token?: unknown; expires_at?: unknown } | null>(response, "gsts token exchange");
    const expiresAt = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (typeof body?.token !== "string" || !body.token || /\s/.test(body.token) ||
        !Number.isFinite(expiresAt) || expiresAt <= this.now() + 60_000) {
      throw new Error("gsts returned an invalid or expired credential");
    }
    return { value: body.token, expiresAt };
  }
}
