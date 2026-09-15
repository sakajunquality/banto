import { signJwt } from "./google-auth.ts";
import { HttpError, httpRequest, parseJson } from "./http.ts";
import type { Logger } from "./log.ts";
import { nullLogger } from "./log.ts";
import type { Fetcher, ObservedJob, ObservedRunner, PoolConfig } from "./types.ts";

export interface RunnerRegistrar {
  createJitRunner(pool: PoolConfig, name: string): Promise<{ runnerId: number; config: string }>;
  removeRunner(pool: PoolConfig, runnerId: number): Promise<void>;
}

/**
 * GitHub App client for the reconcile path.
 *
 * Same auth flow a self-hosted runner image uses to register itself: sign a
 * short-lived RS256 JWT with the App private key, exchange it for an
 * installation access token, use that for the REST calls. The installation
 * token is cached until shortly before it expires — it lives an hour, and
 * reconcile runs every few minutes, so this is one token exchange per hour
 * rather than one per reconcile.
 *
 * GitHub has no "list queued jobs for an org" endpoint, so demand is rebuilt
 * the long way: list each repository's `queued` and `in_progress` workflow
 * runs, then list those runs' jobs and keep the ones still queued or running.
 * The repository set comes from configuration when it is given, and otherwise
 * from the App installation itself.
 */

/**
 * A listing plus whether it is known to be whole.
 *
 * `complete: false` means the listing was truncated (a page budget ran out) or
 * a response did not carry the collection it should have. That is *unknown*,
 * not *empty*, and the difference decides whether a pool may be shrunk: a
 * truncated job listing looks exactly like an idle queue, and a truncated
 * runner listing can hide the busy runner that would have blocked a scale-down.
 */
export interface Listing<T> {
  items: T[];
  complete: boolean;
}

/**
 * The runner cross-check, with "not configured" kept distinct from "failed".
 *
 * The first is a deployment choice — neither the calling pool nor `GITHUB_ORG`
 * names a scope to ask, so there is no runner list to read — and a pool can
 * still be scaled down on the cooldown. The second is missing evidence, and
 * missing evidence must block a lowering. A single nullable value collapsed
 * the two and let a failed cross-check read as an absent one.
 */
export type RunnerListing = { configured: false } | ({ configured: true } & Listing<ObservedRunner>);

/** What the last response said about the installation's remaining API budget. */
export interface RateLimitState {
  remaining: number;
  limit: number;
  resetAt: number;
}

export interface GitHubClient {
  /** Every job currently queued or running in the watched repositories. */
  observeJobs(): Promise<Listing<ObservedJob>>;
  /**
   * The self-hosted runners registered with `repo` (when given) or the org,
   * and whether each is busy.
   *
   * `repo` is the calling pool's own registration scope, not a deployment-wide
   * setting: two calls in the same pass can legitimately ask about different
   * things, one pool at a time, because the client has no notion of "pool" —
   * only the controller does. Omit it to ask the org, which is what every pool
   * did before this parameter existed.
   */
  observeRunners(repo?: string): Promise<RunnerListing>;
  /** The rate-limit headers from the most recent call, if any were seen. */
  rateLimit(): RateLimitState | null;
}

export interface GitHubAppOptions {
  appId: string;
  installationId: string;
  privateKey: string;
  /** Explicit `owner/repo` list. Empty means "ask the installation". */
  repos?: string[];
  /**
   * Org whose runner registrations are cross-checked during reconcile, for
   * pools that do not declare their own `runnerRepo`. Deployment-wide, unlike
   * `runnerRepo`, because there is exactly one GitHub App installation per
   * client — see "One GitHub App, one installation" in the README.
   */
  org?: string;
  apiBaseUrl?: string;
  fetchImpl?: Fetcher;
  now?: () => number;
  logger?: Logger;
  /** Safety valve on very busy installations. */
  maxPagesPerQuery?: number;
  concurrency?: number;
  timeoutMs?: number;
}

interface InstallationToken {
  value: string;
  expiresAt: number;
}

const TOKEN_SKEW_MS = 60_000;
/**
 * `owner/repo`, with nothing that could alter a URL path.
 *
 * Dots are legal in repository names (`.github` is a real one), so they cannot
 * simply be banned — but a segment that is exactly `.` or `..` is a traversal,
 * and `../repo` would turn a repository listing into a request to a path banto
 * never meant to reach.
 */
const PATH_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/**
 * Do two rows for one entity describe the same thing?
 *
 * Only used to decide whether a merge is safe to perform silently. Labels are
 * the field that decides *which pool* a runner or job belongs to, so two rows
 * disagreeing about them is not a state change banto can reconcile — it is a
 * contradiction, and the listing has to say so.
 */
function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].map((l) => l.toLowerCase()).sort();
  const right = [...b].map((l) => l.toLowerCase()).sort();
  return left.every((label, i) => label === right[i]);
}

/**
 * Fold one page's `total_count` into what previous pages reported.
 *
 * Keeping only the latest is wrong: if page 1 says 101 and page 2 says 100,
 * membership changed mid-listing, and the row that left is not necessarily the
 * row banto failed to see. Taking the larger keeps the earlier evidence that
 * something was missing, and the disagreement itself makes the listing partial.
 */
function foldTotal(previous: number | null, next: number): { total: number; consistent: boolean } {
  if (previous === null) return { total: next, consistent: true };
  return { total: Math.max(previous, next), consistent: previous === next };
}

export function isSafeRepoName(name: string): boolean {
  const parts = name.split("/");
  return parts.length === 2 && parts.every((part) => PATH_SEGMENT.test(part));
}

export class GitHubAppClient implements GitHubClient, RunnerRegistrar {
  private readonly api: string;
  private readonly fetchImpl: Fetcher;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly maxPages: number;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private token: InstallationToken | null = null;
  private lastRateLimit: RateLimitState | null = null;
  private inflight: Promise<InstallationToken> | null = null;

  constructor(private readonly options: GitHubAppOptions) {
    this.api = options.apiBaseUrl ?? "https://api.github.com";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? nullLogger;
    this.maxPages = options.maxPagesPerQuery ?? 5;
    this.concurrency = options.concurrency ?? 4;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async createJitRunner(pool: PoolConfig, name: string): Promise<{ runnerId: number; config: string }> {
    const what = "GitHub JIT runner registration";
    const response = await httpRequest(this.fetchImpl, `${this.api}${this.runnerScope(pool)}/generate-jitconfig`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.installationToken()}`, "content-type": "application/json",
        accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      body: JSON.stringify({ name, runner_group_id: pool.runnerGroupId ?? 1, labels: pool.labels, work_folder: "_work" }),
    }, what, this.timeoutMs);
    this.recordRateLimit(response.headers);
    if (!response.ok) throw new HttpError(what, response.status);
    const body = parseJson<{ runner?: { id?: unknown }; encoded_jit_config?: unknown }>(response, what);
    if (typeof body.runner?.id !== "number" || !Number.isSafeInteger(body.runner.id) || body.runner.id <= 0 ||
      typeof body.encoded_jit_config !== "string" || !body.encoded_jit_config) {
      throw new Error(`${what} returned an unreadable configuration`);
    }
    return { runnerId: body.runner.id, config: body.encoded_jit_config };
  }

  async removeRunner(pool: PoolConfig, runnerId: number): Promise<void> {
    if (!Number.isSafeInteger(runnerId) || runnerId <= 0) throw new Error("invalid runner id");
    const what = "GitHub retired runner cleanup";
    const response = await httpRequest(this.fetchImpl, `${this.api}${this.runnerScope(pool)}/${runnerId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${await this.installationToken()}`,
        accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    }, what, this.timeoutMs);
    this.recordRateLimit(response.headers);
    if (!response.ok && response.status !== 404) throw new HttpError(what, response.status);
  }

  private runnerScope(pool: PoolConfig): string {
    if (pool.runnerRepo && isSafeRepoName(pool.runnerRepo)) return `/repos/${pool.runnerRepo}/actions/runners`;
    const org = this.options.org;
    if (pool.runnerRepo || !org || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org)) throw new Error("invalid JIT registration scope");
    return `/orgs/${org}/actions/runners`;
  }

  async observeJobs(): Promise<Listing<ObservedJob>> {
    let complete = true;
    const repoListing = this.options.repos?.length
      ? { items: this.options.repos, complete: true }
      : await this.installationRepos();
    complete &&= repoListing.complete;
    const repos = repoListing.items;

    const runs = await mapWithConcurrency(repos, this.concurrency, (repo) => this.activeRuns(repo));
    const pairs: { repo: string; runId: number }[] = [];
    for (const [index, repo] of repos.entries()) {
      const listing = runs[index];
      // Defensive: `mapWithConcurrency` fills every index, so this is currently
      // unreachable. If it ever is reached, a missing sub-listing means work
      // banto did not see — reading it as "no runs" while leaving the evidence
      // complete is the exact inversion the type split exists to prevent.
      if (!listing) {
        complete = false;
        continue;
      }
      complete &&= listing.complete;
      for (const runId of listing.items) pairs.push({ repo, runId });
    }

    const jobLists = await mapWithConcurrency(pairs, this.concurrency, ({ repo, runId }) =>
      this.runJobs(repo, runId),
    );
    const byId = new Map<number, ObservedJob>();
    for (const listing of jobLists) {
      if (!listing) {
        complete = false;
        continue;
      }
      complete &&= listing.complete;
      for (const job of listing.items) {
        // The same rule as the per-run merge, which this used to bypass with an
        // unconditional `set`: one job can reach this loop from two listings —
        // a run listed under two repositories, or a repository configured
        // twice — and the last write would win, downgrading a running job to a
        // queued one and removing the barrier it was holding.
        const existing = byId.get(job.id);
        if (existing === undefined) {
          byId.set(job.id, job);
          continue;
        }
        if (!sameLabels(existing.labels, job.labels)) complete = false;
        if (existing.status === "queued" && job.status === "in_progress") byId.set(job.id, job);
      }
    }
    this.logger.debug("observed github jobs", {
      repos: repos.length,
      runs: pairs.length,
      jobs: byId.size,
      complete,
    });
    return { items: [...byId.values()], complete };
  }

  /**
   * `GET /repos/{owner}/{repo}/actions/runners` when the calling pool declares
   * where it registers, otherwise `GET /orgs/{org}/actions/runners` — the
   * cross-check that turns "we set the instance count" into "the instances
   * actually became runners". Needs the App's `Organization -> Self-hosted
   * runners` permission for the org form, or `Administration: read` on the
   * repository for the repo form. Not `Actions: read` — that covers runs and
   * jobs; GitHub describes this endpoint as needing admin access to the
   * repository, which for an App is Administration. An App that mints runner
   * registration tokens already holds the write version of it.
   *
   * The two endpoints share this method's pagination and row-classification
   * because a runner row means the same thing at either one: an id, a `busy`
   * flag, a status, a set of labels, folded into a listing the same way
   * `total_count` disagreements and repeated rows are folded for the org form
   * today. Only the URL differs.
   */
  async observeRunners(repo?: string): Promise<RunnerListing> {
    if (repo !== undefined) {
      // Defense in depth, not the primary guard: config validates a pool's
      // `runnerRepo` with this exact predicate at startup. Reaching this with
      // an unsafe name would mean that guard was bypassed, and the safe
      // response is not "not configured" — the pool did declare a scope, so
      // failing open to the cooldown would be exactly the gap this parameter
      // exists to close. Missing evidence blocks a lowering instead.
      if (!isSafeRepoName(repo)) return { configured: true, items: [], complete: false };
      return this.fetchRunnerListing(`/repos/${repo}/actions/runners`);
    }
    const org = this.options.org;
    if (!org) return { configured: false };
    return this.fetchRunnerListing(`/orgs/${org}/actions/runners`);
  }

  private async fetchRunnerListing(basePath: string): Promise<RunnerListing> {
    // Keyed by id: GitHub paginates by offset, so a registration change between
    // two page fetches shifts the window and can return one runner twice while
    // never returning another. Counting raw rows against `total_count` lets the
    // duplicate stand in for the missing one and the listing still calls itself
    // complete — and "complete" is what permits a scale-down.
    const byId = new Map<number, ObservedRunner>();
    let complete = true;
    let total: number | null = null;
    for (let page = 1; page <= this.maxPages; page++) {
      const body = await this.request<{
        runners?: unknown;
        total_count?: unknown;
      }>(`${basePath}?per_page=100&page=${page}`, "GitHub runner listing");
      if (!Array.isArray(body.runners)) {
        complete = false;
        break;
      }
      const count = readTotalCount(body.total_count);
      if (count === "unreadable") complete = false;
      else if (count !== "missing") {
        const folded = foldTotal(total, count);
        total = folded.total;
        // Pages disagreeing about how many rows exist means membership changed
        // while banto was reading. It cannot tell which row moved.
        if (!folded.consistent) complete = false;
      }
      const batch = body.runners;
      for (const raw of batch) {
        const runner = readRunner(raw);
        // A runner banto cannot read fully could be the busy one that should
        // have blocked a scale-down, so it makes the whole listing partial.
        if (runner === null) {
          complete = false;
          continue;
        }
        const existing = byId.get(runner.id);
        if (existing === undefined) {
          byId.set(runner.id, runner);
          continue;
        }
        // Two rows for one runner means its state changed between the page
        // fetches, so both readings really happened. Dropping the later one
        // would throw away evidence banto was handed — and if that reading was
        // `busy`, it is exactly the evidence that blocks a scale-down. Keep
        // whichever reading refuses to shrink the pool.
        //
        // Labels are different in kind. `busy` merges because either reading
        // alone justifies refusing to shrink; labels decide *which pool* that
        // refusal protects, and there is no reading that is conservative for
        // both. Merging them silently sends the busy flag to one pool and lets
        // the other scale down on evidence that was never about it.
        //
        // Conflicting status readings also show that the listing changed
        // while it was fetched. Neither reading establishes current staffing;
        // report partial evidence, which blocks shrinking and resets cooldown.
        if (!sameLabels(existing.labels, runner.labels)) complete = false;
        if (existing.status !== runner.status) complete = false;
        byId.set(runner.id, { ...existing, busy: existing.busy || runner.busy });
      }
      if (batch.length < 100) break;
      if (page === this.maxPages) complete = false;
    }
    // Distinct runners, not rows read.
    if (total !== null && byId.size < total) complete = false;
    const runners = [...byId.values()];
    this.logger.debug("observed github runners", { scope: basePath, runners: runners.length, complete });
    return { configured: true, items: runners, complete };
  }

  private async installationRepos(): Promise<Listing<string>> {
    const repos: string[] = [];
    // Distinct names, for the same reason the runner listing keys by id: a
    // repeated row must not stand in for a repository that was never returned,
    // whose queued jobs would then be missing from demand.
    const seen = new Set<string>();
    let complete = true;
    let total: number | null = null;
    for (let page = 1; page <= this.maxPages; page++) {
      const body = await this.request<{ repositories?: unknown; total_count?: unknown }>(
        `/installation/repositories?per_page=100&page=${page}`,
        "GitHub installation repository listing",
      );
      if (!Array.isArray(body.repositories)) {
        complete = false;
        break;
      }
      const count = readTotalCount(body.total_count);
      if (count === "unreadable") complete = false;
      else if (count !== "missing") {
        const folded = foldTotal(total, count);
        total = folded.total;
        // Pages disagreeing about how many rows exist means membership changed
        // while banto was reading. It cannot tell which row moved.
        if (!folded.consistent) complete = false;
      }
      const batch = body.repositories;
      for (const raw of batch) {
        const name = (raw as { full_name?: unknown })?.full_name;
        // Validated before it is ever used in a URL: a name from the API is
        // upstream data, and `../` in a path segment would redirect the
        // request. A repository banto cannot address is a repository whose
        // jobs it cannot see, which makes the evidence partial.
        if (typeof name === "string" && isSafeRepoName(name)) {
          if (seen.has(name)) continue;
          seen.add(name);
          repos.push(name);
        } else complete = false;
      }
      if (batch.length < 100) break;
      if (page === this.maxPages) complete = false;
    }
    if (total !== null && seen.size < total) complete = false;
    return { items: repos, complete };
  }

  private async activeRuns(repo: string): Promise<Listing<number>> {
    const ids = new Set<number>();
    let complete = true;
    if (!isSafeRepoName(repo)) return { items: [], complete: false };
    for (const status of ["queued", "in_progress"] as const) {
      // Per status: `ids` spans both queries, so it cannot be compared against
      // one query's `total_count`.
      const seen = new Set<number>();
      let total: number | null = null;
      for (let page = 1; page <= this.maxPages; page++) {
        const body = await this.request<{ workflow_runs?: unknown; total_count?: unknown }>(
          `/repos/${repo}/actions/runs?status=${status}&per_page=100&page=${page}`,
          "GitHub workflow run listing",
        );
        if (!Array.isArray(body.workflow_runs)) {
          complete = false;
          break;
        }
        const count = readTotalCount(body.total_count);
        if (count === "unreadable") complete = false;
        else if (count !== "missing") {
        const folded = foldTotal(total, count);
        total = folded.total;
        // Pages disagreeing about how many rows exist means membership changed
        // while banto was reading. It cannot tell which row moved.
        if (!folded.consistent) complete = false;
      }
        const batch = body.workflow_runs;
        for (const raw of batch) {
          const id = (raw as { id?: unknown })?.id;
          // A run banto cannot address is a run whose jobs it cannot count.
          if (typeof id === "number") {
            seen.add(id);
            ids.add(id);
          } else complete = false;
        }
        if (batch.length < 100) break;
        if (page === this.maxPages) complete = false;
      }
      // GitHub's own count of what this query matches. Fewer *distinct* runs
      // than that means banto did not see all of them, whatever the page sizes
      // said and however often a row repeated across pages.
      if (total !== null && seen.size < total) complete = false;
    }
    return { items: [...ids], complete };
  }

  private async runJobs(repo: string, runId: number): Promise<Listing<ObservedJob>> {
    // Merged by id, for the same reason the runner listing is. Every job id the
    // run returned, finished ones included: `total_count`
    // covers them, so this is what may be compared against it. Keyed rather
    // than counted so a row repeated across pages cannot stand in for a job
    // that was never returned — which, for an `in_progress` job, is the
    // evidence that would have blocked a scale-down.
    const seenIds = new Set<number>();
    const byId = new Map<number, ObservedJob>();
    let complete = true;
    let total: number | null = null;
    for (let page = 1; page <= this.maxPages; page++) {
      const body = await this.request<{ jobs?: unknown; total_count?: unknown }>(
        `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
        "GitHub workflow job listing",
      );
      if (!Array.isArray(body.jobs)) {
        complete = false;
        break;
      }
      const count = readTotalCount(body.total_count);
      if (count === "unreadable") complete = false;
      else if (count !== "missing") {
        const folded = foldTotal(total, count);
        total = folded.total;
        // Pages disagreeing about how many rows exist means membership changed
        // while banto was reading. It cannot tell which row moved.
        if (!folded.consistent) complete = false;
      }
      const batch = body.jobs;
      for (const raw of batch) {
        const rawId = (raw as { id?: unknown })?.id;
        // Recorded before filtering: `total_count` covers every job in the run,
        // including the finished ones banto drops.
        if (typeof rawId === "number") seenIds.add(rawId);
        const job = readJob(raw);
        if (job === "unreadable") {
          // A job whose labels or status banto cannot read is demand it cannot
          // attribute to a pool, which is demand it might miss entirely.
          complete = false;
          continue;
        }
        if (job === null) continue;
        // `in_progress` outranks `queued`: a running job blocks a scale-down,
        // and a duplicate row carrying that status must not be discarded just
        // because an earlier page called the same job queued.
        const existing = byId.get(job.id);
        if (existing === undefined) {
          byId.set(job.id, job);
          continue;
        }
        // Same job, different labels: banto cannot say which pool the work is
        // for, so it cannot say the listing is complete for either.
        if (!sameLabels(existing.labels, job.labels)) complete = false;
        if (existing.status === "queued" && job.status === "in_progress") byId.set(job.id, job);
      }
      if (batch.length < 100) break;
      if (page === this.maxPages) complete = false;
    }
    if (total !== null && seenIds.size < total) complete = false;
    return { items: [...byId.values()], complete };
  }

  /**
   * `what` is a fixed description, never the path: paths are built from
   * upstream-supplied repository names, and an error message is exactly where
   * an attacker-chosen string does not belong.
   */
  private async request<T>(path: string, what: string): Promise<T> {
    const response = await httpRequest(
      this.fetchImpl,
      `${this.api}${path}`,
      {
        headers: {
          authorization: `Bearer ${await this.installationToken()}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
      what,
      this.timeoutMs,
    );
    this.recordRateLimit(response.headers);
    if (!response.ok) throw new HttpError(what, response.status);
    return parseJson<T>(response, what);
  }

  rateLimit(): RateLimitState | null {
    return this.lastRateLimit;
  }

  /**
   * Track the installation's remaining budget so `rateLimit()` has something
   * current to report. This only records the headers; it does not itself
   * decide whether the budget is worrying. That decision needs to be made
   * once per sweep across every pool sharing this one client, not once per
   * HTTP call — see `Controller.reportBudget`, the caller of `rateLimit()`.
   * Warning here too would double-report the same installation-wide number
   * once per call in addition to once per reconcile.
   */
  private recordRateLimit(headers: Headers): void {
    const remaining = parseHeaderInt(headers, "x-ratelimit-remaining");
    const limit = parseHeaderInt(headers, "x-ratelimit-limit");
    const reset = parseHeaderInt(headers, "x-ratelimit-reset");
    if (remaining === null || limit === null) return;
    this.lastRateLimit = { remaining, limit, resetAt: (reset ?? 0) * 1000 };
  }

  private async installationToken(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAt - TOKEN_SKEW_MS > this.now()) return cached.value;
    this.inflight ??= this.mintInstallationToken().finally(() => {
      this.inflight = null;
    });
    const fresh = await this.inflight;
    this.token = fresh;
    return fresh.value;
  }

  private async mintInstallationToken(): Promise<InstallationToken> {
    const issuedAt = Math.floor(this.now() / 1000);
    const jwt = signJwt(
      { alg: "RS256", typ: "JWT" },
      // 60s back-dated for clock skew, 9 minutes forward (GitHub caps at 10).
      { iat: issuedAt - 60, exp: issuedAt + 540, iss: this.options.appId },
      this.options.privateKey,
    );
    const response = await httpRequest(
      this.fetchImpl,
      `${this.api}/app/installations/${this.options.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
      "GitHub installation token exchange",
      this.timeoutMs,
    );
    if (!response.ok) {
      // No body: a failed token exchange can echo the assertion back.
      throw new Error(`GitHub installation token exchange failed: HTTP ${response.status}`);
    }
    let body: { token?: string; expires_at?: string };
    try {
      body = JSON.parse(response.text) as { token?: string; expires_at?: string };
    } catch {
      // The parse error message would quote the body, and the body is a token.
      throw new Error("GitHub installation token response was not JSON");
    }
    if (!body.token) throw new Error("GitHub installation token response had no token");
    const parsed = body.expires_at ? Date.parse(body.expires_at) : Number.NaN;
    // Never invent an hour of validity for a response we could not read: a
    // conservative few minutes means the next call re-mints instead of retrying
    // with a token GitHub may already have expired.
    const expiresAt = Number.isFinite(parsed) ? parsed : this.now() + 5 * 60_000;
    return { value: body.token, expiresAt };
  }
}

/**
 * Read a job, or say it could not be read.
 *
 * `null` means "read fine, not interesting" (a finished job); `"unreadable"`
 * means a required field was missing or the wrong type, which has to make the
 * listing partial rather than quietly dropping a row.
 */
function readJob(raw: unknown): ObservedJob | null | "unreadable" {
  if (typeof raw !== "object" || raw === null) return "unreadable";
  const job = raw as { id?: unknown; status?: unknown; labels?: unknown };
  if (typeof job.id !== "number") return "unreadable";
  if (typeof job.status !== "string") return "unreadable";
  // Known statuses that are genuinely not runnable work. Anything else — a
  // status GitHub adds later, or one banto has never seen — is NOT assumed
  // finished: reading an unknown status as "not interesting" would drop a job
  // that is actually running, and a running job is what blocks a scale-down.
  if (job.status !== "queued" && job.status !== "in_progress") {
    const settled = ["completed", "waiting", "pending", "requested"];
    return settled.includes(job.status) ? null : "unreadable";
  }
  // A running job with no labels cannot be matched to a pool, so it would
  // silently not count as demand.
  if (!Array.isArray(job.labels) || !job.labels.every((label) => typeof label === "string")) return "unreadable";
  return { id: job.id, status: job.status, labels: job.labels as string[] };
}

/** Read a runner, or null when a field banto relies on is missing. */
function readRunner(raw: unknown): ObservedRunner | null {
  if (typeof raw !== "object" || raw === null) return null;
  const runner = raw as { id?: unknown; name?: unknown; busy?: unknown; status?: unknown; labels?: unknown };
  if (typeof runner.id !== "number") return null;
  // `busy` decides whether a scale-down is blocked; absent must not read false.
  if (typeof runner.busy !== "boolean") return null;
  if (runner.status !== "online" && runner.status !== "offline") return null;
  if (!Array.isArray(runner.labels)) return null;
  const labels: string[] = [];
  for (const label of runner.labels) {
    const name = (label as { name?: unknown })?.name;
    if (typeof name !== "string" || name === "") return null;
    labels.push(name);
  }
  return {
    id: runner.id,
    name: typeof runner.name === "string" ? runner.name : String(runner.id),
    busy: runner.busy,
    status: runner.status,
    labels,
  };
}

/**
 * Read a listing's `total_count`.
 *
 * `"missing"` is fine — not every endpoint sends one. `"unreadable"` is not: a
 * count that is a string, negative or fractional means banto cannot tell
 * whether it saw every row, and a listing it cannot vouch for must be partial.
 * The evidence union protects consumers *after* classification; it does nothing
 * for a listing classified wrongly.
 */
function readTotalCount(value: unknown): number | "missing" | "unreadable" {
  if (value === undefined || value === null) return "missing";
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return "unreadable";
  return value;
}

function parseHeaderInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}
