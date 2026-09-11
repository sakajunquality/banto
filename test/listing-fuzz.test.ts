import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { GitHubAppClient } from "../src/github.ts";
import type { Fetcher } from "../src/types.ts";

/**
 * Fuzzing the listings, because "complete" is a safety claim.
 *
 * Every field banto reads from a listing can be missing or the wrong type in a
 * real response — a proxy rewriting a body, an API change, a truncated page.
 * The rule is that anything banto cannot read fully makes the listing partial,
 * and partial evidence cannot lower a count. These cases are the ones a
 * hand-written test would not think to write: an empty `full_name`, a running
 * job with no labels, a runner with no `busy`, a `total_count` that disagrees
 * with the rows.
 */

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const NOW = 1_700_000_000_000;

function client(
  handler: (path: string, url: URL) => unknown,
  options: { org?: string; repos?: string[] } = {},
) {
  const fetchImpl: Fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/access_tokens")) {
      return Response.json({ token: "t", expires_at: new Date(NOW + 3_600_000).toISOString() });
    }
    return Response.json(handler(url.pathname, url) ?? {});
  };
  return new GitHubAppClient({
    appId: "1",
    installationId: "2",
    privateKey: PEM,
    now: () => NOW,
    fetchImpl,
    ...(options.org === undefined ? {} : { org: options.org }),
    ...(options.repos === undefined ? { repos: ["owner/repo"] } : { repos: options.repos }),
  });
}

const RUN = { id: 100 };
const GOOD_JOB = { id: 1, status: "queued", labels: ["self-hosted"] };

/** Each case names a malformation and the listing that should carry it. */
const JOB_CASES: [string, (path: string) => unknown][] = [
  ["a job with no id", (p) => (p.endsWith("/jobs") ? { jobs: [{ status: "queued", labels: [] }] } : { workflow_runs: [RUN] })],
  ["a job with no status", (p) => (p.endsWith("/jobs") ? { jobs: [{ id: 1, labels: [] }] } : { workflow_runs: [RUN] })],
  [
    "a running job with no labels",
    (p) => (p.endsWith("/jobs") ? { jobs: [{ id: 1, status: "in_progress" }] } : { workflow_runs: [RUN] }),
  ],
  [
    "a job whose labels are not strings",
    (p) => (p.endsWith("/jobs") ? { jobs: [{ id: 1, status: "queued", labels: [{ name: "x" }] }] } : { workflow_runs: [RUN] }),
  ],
  ["a job that is not an object", (p) => (p.endsWith("/jobs") ? { jobs: ["queued"] } : { workflow_runs: [RUN] })],
  [
    "a jobs page whose total_count exceeds the rows",
    (p) => (p.endsWith("/jobs") ? { jobs: [GOOD_JOB], total_count: 5 } : { workflow_runs: [RUN] }),
  ],
  // `readTotalCount` refuses anything that is not a non-negative integer, and
  // the whole suite passed with that refusal deleted — the guard existed but
  // nothing held it in place. A count banto cannot read is a count it cannot
  // check the rows against, which is the definition of a partial listing.
  ...([
    ["a string", "5"],
    ["a numeric string", "1"],
    ["a negative number", -1],
    ["a fraction", 1.5],
    // NaN and Infinity are deliberately absent: `JSON.stringify` writes both as
    // `null`, so neither can arrive over the wire. A test for them would assert
    // on the "missing" path under a misleading name.
    ["a boolean", true],
    ["an object", { count: 1 }],
  ] as const).map(
    ([name, total]) =>
      [
        `a jobs page whose total_count is ${name}`,
        (p: string) => (p.endsWith("/jobs") ? { jobs: [GOOD_JOB], total_count: total } : { workflow_runs: [RUN] }),
      ] as [string, (path: string) => unknown],
  ),
  ["a runs page with no array", () => ({ workflow_runs: null })],
  ["a run with no id", () => ({ workflow_runs: [{ name: "build" }] })],
  ["a runs page whose total_count exceeds the rows", () => ({ workflow_runs: [], total_count: 5 })],
];

describe("a listing banto cannot read fully is never complete", () => {
  for (const [name, handler] of JOB_CASES) {
    test(name, async () => {
      const listing = await client((path) => handler(path)).observeJobs();
      expect({ case: name, complete: listing.complete }).toEqual({ case: name, complete: false });
    });
  }

  test("a well-formed listing is complete, so the cases above mean something", async () => {
    const listing = await client((path) =>
      path.endsWith("/jobs") ? { jobs: [GOOD_JOB], total_count: 1 } : { workflow_runs: [RUN], total_count: 1 },
    ).observeJobs();
    expect(listing).toEqual({ items: [{ id: 1, status: "queued", labels: ["self-hosted"] }], complete: true });
  });
});

const RUNNER_CASES: [string, unknown][] = [
  ["a runner with no busy flag", { id: 1, status: "online", labels: [{ name: "self-hosted" }] }],
  ["a runner whose busy flag is a string", { id: 1, busy: "false", status: "online", labels: [] }],
  ["a runner with no status", { id: 1, busy: false, labels: [{ name: "self-hosted" }] }],
  ["a runner with an unknown status", { id: 1, busy: false, status: "provisioning", labels: [] }],
  ["a runner with no labels array", { id: 1, busy: false, status: "online" }],
  ["a runner with a nameless label", { id: 1, busy: false, status: "online", labels: [{}] }],
  ["a runner with an empty label", { id: 1, busy: false, status: "online", labels: [{ name: "" }] }],
  ["a runner that is not an object", "runner-1"],
];

describe("a runner listing banto cannot read fully is never complete", () => {
  for (const [name, runner] of RUNNER_CASES) {
    test(name, async () => {
      const listing = await client(() => ({ runners: [runner] }), { org: "acme" }).observeRunners();
      expect({ case: name, listing }).toEqual({
        case: name,
        listing: { configured: true, items: [], complete: false },
      });
    });
  }

  test("a total_count above the rows makes it incomplete", async () => {
    const listing = await client(() => ({ runners: [], total_count: 3 }), { org: "acme" }).observeRunners();
    expect(listing).toEqual({ configured: true, items: [], complete: false });
  });

  test("a well-formed runner listing is complete", async () => {
    const listing = await client(
      () => ({ runners: [{ id: 1, busy: true, status: "online", labels: [{ name: "self-hosted" }] }], total_count: 1 }),
      { org: "acme" },
    ).observeRunners();
    expect(listing).toEqual({
      configured: true,
      complete: true,
      items: [{ id: 1, name: "1", busy: true, status: "online", labels: ["self-hosted"] }],
    });
  });
});

describe("an installation listing banto cannot read fully is never complete", () => {
  for (const [name, repositories] of [
    ["a repository with no name", [{}]],
    ["a repository with an empty name", [{ full_name: "" }]],
    ["a repository name that is not a string", [{ full_name: 42 }]],
    ["a traversal in the repository name", [{ full_name: "../evil" }]],
    ["a total_count above the rows", []],
  ] as [string, unknown[]][]) {
    test(name, async () => {
      const listing = await client(
        (path) =>
          path === "/installation/repositories"
            ? { repositories, total_count: name.includes("total_count") ? 5 : repositories.length }
            : { workflow_runs: [] },
        { repos: [] },
      ).observeJobs();
      expect({ case: name, complete: listing.complete }).toEqual({ case: name, complete: false });
    });
  }
});
