import { createPrivateKey } from "node:crypto";
import { isSafeRepoName } from "./github.ts";
import { poolTarget } from "./types.ts";
import { DEFAULT_GCS_PREFIX } from "./gcs.ts";
import type { Severity } from "./log.ts";
import type { PoolConfig } from "./types.ts";

/**
 * Configuration is read from the environment once, at startup, and validated
 * all at once: a bad config stops the process with every problem listed, rather
 * than surfacing as a 500 on the first webhook of the day.
 */

export type StoreKind = "gcs" | "firestore" | "memory";

export interface BantoConfig {
  port: number;
  logLevel: Severity;
  webhookSecret: string;
  pools: PoolConfig[];
  store: StoreKind;
  gcs: { bucket: string; prefix: string };
  firestore: { project: string; database: string; collection: string };
  github: {
    appId: string;
    installationId: string;
    privateKey: string;
    repos: string[];
    /** Org whose runner registrations the reconcile cross-checks. */
    org: string;
  };
  reconcile: { audience: string; allowedEmails: string[] };
  /** Floor on the interval between passes for one pool, in milliseconds. */
  minPassIntervalMs: number;
  maxPagesPerQuery: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * What each component of a worker pool's address may contain.
 *
 * These are deliberately strict. The components are interpolated into a Cloud
 * Run resource path and compared as strings to detect two pools aiming at one
 * worker pool, so anything that could make the path differ from the spelling —
 * a slash, a dot segment, a full resource name, a capital letter, padding —
 * breaks both uses at once.
 *
 * Project *ids* only. A project number addresses the same project and banto
 * cannot tell that `123456789012` and `my-project` are the same without asking
 * Google, so it refuses the form it cannot compare rather than comparing it
 * wrongly.
 */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PROJECT_NUMBER = /^[0-9]+$/;
const LOCATION = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const RESOURCE_ID = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const DEFAULT_COOLDOWN_SECONDS = 300;
/**
 * Floor on the interval between passes for one pool. Every pass spends part of
 * the installation's GitHub rate limit, so this is the knob that bounds the
 * spend when deliveries arrive in a burst.
 */
export const DEFAULT_MIN_PASS_INTERVAL_SECONDS = 10;

/**
 * Pages of 100 rows per GitHub query before the listing gives up and calls
 * itself partial. Five covers 500 runners, 500 repositories, or 500 active runs
 * in one status — comfortably above a normal installation, and a ceiling rather
 * than a target, because running into it stops every pool in the deployment
 * from ever scaling down.
 */
export const DEFAULT_MAX_PAGES_PER_QUERY = 5;

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): BantoConfig {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(`${name} is required`);
      return "";
    }
    return value;
  };

  const webhookSecret = required("GITHUB_WEBHOOK_SECRET");
  const pools = parsePools(env.BANTO_POOLS, problems);

  const store = (env.BANTO_STORE?.trim() || "gcs") as StoreKind;
  if (store !== "gcs" && store !== "firestore" && store !== "memory") {
    problems.push(`BANTO_STORE must be "gcs", "firestore" or "memory", got "${String(env.BANTO_STORE)}"`);
  }

  const gcsBucket = env.BANTO_GCS_BUCKET?.trim() ?? "";
  if (store === "gcs" && !gcsBucket) {
    problems.push("BANTO_GCS_BUCKET is required when BANTO_STORE=gcs (the default store)");
  }
  if (gcsBucket && !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(gcsBucket)) {
    problems.push(`BANTO_GCS_BUCKET "${gcsBucket}" is not a bucket name (did you include gs:// or a path?)`);
  }
  const gcsPrefix = env.BANTO_GCS_PREFIX ?? DEFAULT_GCS_PREFIX;
  if (gcsPrefix.startsWith("/")) problems.push("BANTO_GCS_PREFIX must not start with /");

  const firestoreProject =
    env.BANTO_FIRESTORE_PROJECT?.trim() ||
    env.GOOGLE_CLOUD_PROJECT?.trim() ||
    pools[0]?.project ||
    "";
  if (store === "firestore" && !firestoreProject) {
    problems.push("BANTO_FIRESTORE_PROJECT (or GOOGLE_CLOUD_PROJECT) is required when BANTO_STORE=firestore");
  }

  const installationId = required("GH_APP_INSTALLATION_ID");
  if (installationId && !/^\d+$/.test(installationId)) {
    problems.push(`GH_APP_INSTALLATION_ID must be numeric, got "${installationId}"`);
  }
  const privateKey = normalisePem(required("GH_APP_PRIVATE_KEY"));
  // Load the key here rather than discovering at the first reconcile that the
  // secret holds a placeholder or a truncated paste. Nothing about the key is
  // logged: only whether node could read it.
  if (privateKey) {
    try {
      createPrivateKey(privateKey);
    } catch {
      problems.push("GH_APP_PRIVATE_KEY is not a private key node:crypto can load (expected a PEM)");
    }
  }
  const github = {
    appId: required("GH_APP_ID"),
    installationId,
    privateKey,
    repos: splitList(env.GITHUB_REPOS),
    org: env.GITHUB_ORG?.trim() ?? "",
  };
  // The same predicate the client uses before putting a name in a URL. Two
  // different rules meant a config could start cleanly and then have that
  // repository silently contribute no demand, because the client refused to
  // query it — "../repo" passed here and was rejected there.
  // Both of these end up in a request path, so they get the same treatment as
  // every other path component. A typo should be a startup error, not a
  // silently wrong query against some other org or collection.
  if (github.org && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(github.org)) {
    problems.push(`GITHUB_ORG "${github.org}" is not a GitHub organisation name`);
  }
  const seenRepos = new Set<string>();
  for (const repo of github.repos) {
    if (!isSafeRepoName(repo)) {
      problems.push(
        `GITHUB_REPOS entry "${repo}" is not owner/repo (each part: letters, digits, dot, dash or underscore)`,
      );
    }
    // A repository listed twice is listed twice all the way down: its runs are
    // fetched twice and its jobs arrive from two listings, so one job reaches
    // the merge from two directions. The merge is written to survive that, but
    // there is no reason to configure it and every reason not to pay for it.
    const key = repo.toLowerCase();
    if (seenRepos.has(key)) problems.push(`GITHUB_REPOS lists "${repo}" more than once`);
    seenRepos.add(key);
  }

  // `/reconcile` is always verified in-process: the webhook makes the service
  // public, so Cloud Run IAM cannot protect one path of it, and there is no
  // supported deployment where banto should trust an unverified caller.
  const audience = env.BANTO_RECONCILE_AUDIENCE?.trim() ?? "";
  if (!audience) problems.push("BANTO_RECONCILE_AUDIENCE is required");
  const allowedEmails = splitList(env.BANTO_RECONCILE_ALLOWED_EMAILS);
  // An audience is a name, not a permission: any Google principal can mint a
  // token for any audience. Verifying one without an allowlist would let any
  // Google service account reconcile.
  if (allowedEmails.length === 0) {
    problems.push(
      "BANTO_RECONCILE_ALLOWED_EMAILS is required: list the service accounts allowed to call /reconcile",
    );
  }
  for (const email of allowedEmails) {
    if (!email.includes("@")) problems.push(`BANTO_RECONCILE_ALLOWED_EMAILS entry "${email}" is not an email address`);
  }

  const passInterval = parseNonNegativeInt(
    env.BANTO_MIN_PASS_INTERVAL_SECONDS,
    DEFAULT_MIN_PASS_INTERVAL_SECONDS,
    "BANTO_MIN_PASS_INTERVAL_SECONDS",
    problems,
  );
  // A query that runs out of pages is permanently partial, and partial
  // evidence never shrinks a pool — so an installation larger than this
  // ceiling can never scale down at all. Configurable because the right value
  // is a property of the installation, not of banto.
  const maxPages = parseNonNegativeInt(
    env.BANTO_MAX_PAGES_PER_QUERY,
    DEFAULT_MAX_PAGES_PER_QUERY,
    "BANTO_MAX_PAGES_PER_QUERY",
    problems,
  );
  if (maxPages < 1) problems.push("BANTO_MAX_PAGES_PER_QUERY must be at least 1");
  const firestoreCollection = env.BANTO_FIRESTORE_COLLECTION?.trim() || "banto-pools";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(firestoreCollection)) {
    problems.push(
      `BANTO_FIRESTORE_COLLECTION "${firestoreCollection}" must be 1-63 characters of letters, digits, dot, dash or underscore`,
    );
  }
  const port = parsePort(env.PORT, problems);
  const logLevel = parseLogLevel(env.LOG_LEVEL, problems);

  if (problems.length > 0) throw new ConfigError(problems.filter(Boolean));

  return {
    port,
    logLevel,
    webhookSecret,
    pools,
    store,
    gcs: { bucket: gcsBucket, prefix: gcsPrefix },
    firestore: {
      project: firestoreProject,
      database: env.BANTO_FIRESTORE_DATABASE?.trim() || "(default)",
      collection: firestoreCollection,
    },
    github,
    reconcile: { audience, allowedEmails },
    minPassIntervalMs: passInterval * 1000,
    maxPagesPerQuery: maxPages,
  };
}

function parsePools(raw: string | undefined, problems: string[]): PoolConfig[] {
  if (!raw?.trim()) {
    problems.push("BANTO_POOLS is required (a JSON array of pool objects)");
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    problems.push(`BANTO_POOLS is not valid JSON: ${(error as Error).message}`);
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    problems.push("BANTO_POOLS must be a non-empty JSON array");
    return [];
  }

  const pools: PoolConfig[] = [];
  const seen = new Set<string>();
  const targets = new Map<string, string>();
  parsed.forEach((entry, index) => {
    const where = `BANTO_POOLS[${index}]`;
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${where} must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const str = (field: string, fallback?: string): string => {
      const value = record[field];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (fallback !== undefined) return fallback;
      problems.push(`${where}.${field} is required`);
      return "";
    };
    const num = (field: string, fallback: number): number => {
      const value = record[field];
      if (value === undefined) return fallback;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        problems.push(`${where}.${field} must be a non-negative integer`);
        return fallback;
      }
      return value;
    };

    const workerPool = str("workerPool");
    const name = str("name", workerPool);
    const project = str("project");
    const location = str("location");

    if (project && !PROJECT_ID.test(project)) {
      problems.push(
        PROJECT_NUMBER.test(project)
          ? `${where}.project must be a project id, not a project number: banto compares pool addresses textually and cannot tell that a number and an id are the same project`
          : `${where}.project "${project}" is not a project id (lowercase letters, digits and hyphens, 6-30 characters, starting with a letter)`,
      );
    }
    if (location && !LOCATION.test(location)) {
      problems.push(`${where}.location "${location}" is not a region (for example asia-northeast1)`);
    }
    if (workerPool && !RESOURCE_ID.test(workerPool)) {
      problems.push(
        `${where}.workerPool "${workerPool}" is not a worker pool name: give the short name (lowercase letters, digits and hyphens), not a path or a full resource name`,
      );
    }
    // Restricted rather than normalised: both stores derive a document or
    // object name from this, and a name that only becomes unique *after*
    // normalisation would give two configured pools one shared document.
    if (name && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) {
      problems.push(
        `${where}.name "${name}" must be 1-63 characters of letters, digits, dot, dash or underscore (it becomes a storage key)`,
      );
    }
    const labels = record.labels;
    if (!Array.isArray(labels) || labels.length === 0 || !labels.every((l) => typeof l === "string" && l.trim())) {
      problems.push(`${where}.labels must be a non-empty array of strings`);
    }
    if (record.max === undefined) problems.push(`${where}.max is required`);

    const pool: PoolConfig = {
      name,
      project,
      location,
      workerPool,
      labels: Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string").map((l) => l.trim()) : [],
      min: num("min", 0),
      max: num("max", 0),
      warmSpare: num("warmSpare", 0),
      cooldownSeconds: num("cooldownSeconds", DEFAULT_COOLDOWN_SECONDS),
    };
    if (pool.max < pool.min) problems.push(`${where}.max (${pool.max}) is below min (${pool.min})`);
    if (pool.warmSpare > pool.max) {
      problems.push(`${where}.warmSpare (${pool.warmSpare}) exceeds max (${pool.max}), so the spare can never exist`);
    }
    if (name && seen.has(name)) problems.push(`${where}.name "${name}" is used by more than one pool`);
    seen.add(name);

    // Two logical pools pointing at one worker pool is not a configuration
    // banto can serve: each keeps its own demand and its own cooldown, both
    // decide correctly for themselves, and the two decisions fight over one
    // instance count — a pool cycling 0 -> 1 -> 0 under steady demand.
    // Safe to compare as text only because every component was validated into
    // a single spelling above.
    const target = poolTarget(pool);
    const other = targets.get(target);
    if (other !== undefined) {
      problems.push(
        `${where} targets the same worker pool as "${other}" (${target}); two pools cannot share one worker pool`,
      );
    } else {
      targets.set(target, name);
    }
    pools.push(pool);
  });
  return pools;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, name: string, problems: string[]): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    problems.push(`${name} must be a non-negative integer, got "${raw}"`);
    return fallback;
  }
  return value;
}

function parsePort(raw: string | undefined, problems: string[]): number {
  if (!raw?.trim()) return 8080;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be a TCP port number, got "${raw}"`);
    return 8080;
  }
  return port;
}

function parseLogLevel(raw: string | undefined, problems: string[]): Severity {
  const value = (raw?.trim() || "INFO").toUpperCase();
  if (value === "DEBUG" || value === "INFO" || value === "WARNING" || value === "ERROR") return value;
  problems.push(`LOG_LEVEL must be one of DEBUG, INFO, WARNING, ERROR; got "${raw}"`);
  return "INFO";
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Secret Manager and `terraform` both survive real newlines, but a PEM pasted
 * into a plain env var often arrives with literal `\n`. Accept both.
 */
export function normalisePem(value: string): string {
  return value.includes("\\n") && !value.includes("\n") ? value.replaceAll("\\n", "\n") : value;
}
