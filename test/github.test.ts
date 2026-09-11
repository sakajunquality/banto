import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { GitHubAppClient, isSafeRepoName } from "../src/github.ts";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const NOW = 1_700_000_000_000;

interface Route {
  runs?: Record<string, { id: number }[]>;
  jobs?: Record<number, { id: number; status: string; labels: string[] }[]>;
  installationRepos?: string[];
}

function client(routes: Route, options: { now?: () => number } = {}) {
  const calls: string[] = [];
  let tokenExchanges = 0;
  const instance = new GitHubAppClient({
    appId: "123456",
    installationId: "98765432",
    privateKey: PEM,
    ...(routes.installationRepos ? {} : { repos: ["example-org/infra"] }),
    now: options.now ?? (() => NOW),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      if (path.includes("/access_tokens")) {
        tokenExchanges++;
        const issuedAt = options.now?.() ?? NOW;
        return Response.json({ token: "ghs_installation", expires_at: new Date(issuedAt + 3_600_000).toISOString() });
      }
      calls.push(path);
      if (url.pathname === "/installation/repositories") {
        return Response.json({ repositories: (routes.installationRepos ?? []).map((full_name) => ({ full_name })) });
      }
      const runsMatch = url.pathname.match(/^\/repos\/(.+)\/actions\/runs$/);
      if (runsMatch) {
        const status = url.searchParams.get("status") ?? "";
        return Response.json({ workflow_runs: routes.runs?.[status] ?? [] });
      }
      const jobsMatch = url.pathname.match(/^\/repos\/.+\/actions\/runs\/(\d+)\/jobs$/);
      if (jobsMatch) {
        return Response.json({ jobs: routes.jobs?.[Number(jobsMatch[1])] ?? [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { instance, calls, tokenExchanges: () => tokenExchanges };
}

describe("GitHub App client", () => {
  test("collects queued and running jobs from the active runs", async () => {
    const { instance } = client({
      runs: { queued: [{ id: 100 }], in_progress: [{ id: 200 }] },
      jobs: {
        100: [{ id: 1, status: "queued", labels: ["self-hosted", "runner-default"] }],
        200: [
          { id: 2, status: "in_progress", labels: ["self-hosted", "runner-build"] },
          { id: 3, status: "completed", labels: ["self-hosted", "runner-build"] },
        ],
      },
    });
    const listing = await instance.observeJobs();
    expect(listing.complete).toBe(true);
    expect(listing.items.map((job) => job.id).sort()).toEqual([1, 2]);
    expect(listing.items.find((job) => job.id === 2)?.status).toBe("in_progress");
  });

  test("a run listed under both statuses is only visited once", async () => {
    const { instance, calls } = client({
      runs: { queued: [{ id: 100 }], in_progress: [{ id: 100 }] },
      jobs: { 100: [{ id: 1, status: "queued", labels: ["self-hosted"] }] },
    });
    const listing = await instance.observeJobs();
    expect(listing.items).toHaveLength(1);
    expect(calls.filter((path) => path.includes("/runs/100/jobs")).length).toBe(1);
  });

  test("falls back to the App installation's repositories when none are configured", async () => {
    const { instance, calls } = client({
      installationRepos: ["example-org/infra", "example-org/app"],
      runs: { queued: [{ id: 100 }] },
      jobs: { 100: [{ id: 1, status: "queued", labels: ["self-hosted"] }] },
    });
    await instance.observeJobs();
    expect(calls[0]).toContain("/installation/repositories");
    expect(calls.filter((path) => path.startsWith("/repos/example-org/app/")).length).toBeGreaterThan(0);
  });

  test("mints one installation token and reuses it until it nears expiry", async () => {
    let now = NOW;
    const { instance, tokenExchanges } = client(
      { runs: { queued: [] }, jobs: {} },
      { now: () => now },
    );
    await instance.observeJobs();
    await instance.observeJobs();
    expect(tokenExchanges()).toBe(1);

    // Just short of the hour: still cached. Past the refresh skew: re-minted.
    now = NOW + 3_000_000;
    await instance.observeJobs();
    expect(tokenExchanges()).toBe(1);
    now = NOW + 3_600_000;
    await instance.observeJobs();
    expect(tokenExchanges()).toBe(2);
  });

  test("an API failure surfaces without leaking the token", async () => {
    const instance = new GitHubAppClient({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      repos: ["example-org/infra"],
      now: () => NOW,
      fetchImpl: async (input) => {
        if (String(input).includes("/access_tokens")) {
          return Response.json({ token: "ghs_secret_value", expires_at: new Date(NOW + 3_600_000).toISOString() });
        }
        return new Response("rate limited", { status: 403 });
      },
    });
    const error = await instance.observeJobs().catch((e: Error) => e);
    expect(String(error)).toContain("HTTP 403");
    expect(String(error)).not.toContain("ghs_secret_value");
  });
});

describe("runner cross-check", () => {
  function runnerClient(runners: unknown[], options: { org?: string } = {}) {
    const calls: string[] = [];
    const instance = new GitHubAppClient({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      repos: ["example-org/infra"],
      ...(options.org === undefined ? { org: "example-org" } : { org: options.org }),
      now: () => NOW,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/access_tokens")) {
          return Response.json({ token: "ghs_x", expires_at: new Date(NOW + 3_600_000).toISOString() });
        }
        calls.push(url.pathname);
        return Response.json({ runners });
      },
    });
    return { instance, calls };
  }

  test("reads each runner's busy flag, status and labels", async () => {
    const { instance, calls } = runnerClient([
      {
        id: 7,
        name: "gh-runner-default-ab12",
        status: "online",
        busy: true,
        labels: [{ name: "self-hosted" }, { name: "runner-default" }],
      },
      { id: 8, name: "gh-runner-build-cd34", status: "offline", busy: false, labels: [{ name: "runner-build" }] },
    ]);
    const listing = await instance.observeRunners();
    expect(calls[0]).toBe("/orgs/example-org/actions/runners");
    expect(listing).toMatchObject({ configured: true, complete: true });
    expect(listing.configured && listing.items).toEqual([
      { id: 7, name: "gh-runner-default-ab12", busy: true, status: "online", labels: ["self-hosted", "runner-default"] },
      { id: 8, name: "gh-runner-build-cd34", busy: false, status: "offline", labels: ["runner-build"] },
    ]);
  });

  test("reports not-configured when there is no org to ask", async () => {
    // Distinct from a failed cross-check: this is a deployment choice, and the
    // controller may still scale down on the cooldown.
    const { instance, calls } = runnerClient([], { org: "" });
    expect(await instance.observeRunners()).toEqual({ configured: false });
    expect(calls).toEqual([]);
  });

  test("a job status banto does not recognise makes the listing partial", async () => {
    // Reading an unknown status as "finished, not interesting" is the
    // dangerous default: a status GitHub adds later that means the job is
    // running would be dropped, and a running job is what blocks a scale-down.
    // Known settled statuses stay uninteresting; anything else is unreadable.
    const { instance } = client({
      runs: { in_progress: [{ id: 100 }] },
      jobs: {
        100: [
          { id: 1, status: "in_progress", labels: ["self-hosted", "runner-default"] },
          { id: 2, status: "some-status-from-the-future", labels: ["self-hosted", "runner-default"] },
        ],
      },
    });
    const listing = await instance.observeJobs();
    expect(listing.complete).toBe(false);
    expect(listing.items.map((job) => job.id)).toEqual([1]);

    // Statuses that really do mean "not runnable work" stay uninteresting.
    const settled = client({
      runs: { in_progress: [{ id: 100 }] },
      jobs: {
        100: [
          { id: 1, status: "completed", labels: ["self-hosted", "runner-default"] },
          { id: 2, status: "waiting", labels: ["self-hosted", "runner-default"] },
        ],
      },
    });
    const ok = await settled.instance.observeJobs();
    expect(ok.complete).toBe(true);
    expect(ok.items).toEqual([]);
  });

  // Both directions, because only one of them constrains the merge rule. With
  // the busy row second, "take the later reading" and "keep whichever reading
  // refuses to shrink" agree, so a test that only plants idle-then-busy passes
  // against either rule and proves nothing. Busy *first* is the case the rule
  // exists for: the runner was seen working, and the fresher row must not erase
  // that. This test used to run only the direction that could not fail.
  test.each([
    ["the busy reading arrives second", true],
    ["the busy reading arrives first", false],
  ])("a repeated runner keeps its busy reading when %s", async (_name, busyOnSecondPage) => {
    const row = (id: number, busy: boolean) => ({
      id,
      name: `r${id}`,
      status: "online",
      busy,
      labels: [{ name: "self-hosted" }, { name: "runner-default" }],
    });
    const first = Array.from({ length: 100 }, (_, i) => row(i + 1, !busyOnSecondPage && i + 1 === 100));
    const instance = new GitHubAppClient({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      org: "example-org",
      repos: ["example-org/infra"],
      now: () => NOW,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/access_tokens")) {
          return Response.json({ token: "t", expires_at: new Date(NOW + 3_600_000).toISOString() });
        }
        const which = Number(url.searchParams.get("page") ?? "1");
        // Runner 100's state changed between the two page fetches.
        return Response.json({ total_count: 100, runners: which === 1 ? first : [row(100, busyOnSecondPage)] });
      },
    });

    const listing = await instance.observeRunners();
    const items = listing.configured ? listing.items : [];
    expect(items.length).toBe(100);
    expect(items.filter((r) => r.busy).map((r) => r.id)).toEqual([100]);
  });

  test("a repeated job that has since started running keeps its running status", async () => {
    const { instance } = client({
      runs: { in_progress: [{ id: 100 }] },
      jobs: {
        100: [
          { id: 1, status: "queued", labels: ["self-hosted", "runner-default"] },
          { id: 1, status: "in_progress", labels: ["self-hosted", "runner-default"] },
        ],
      },
    });
    const listing = await instance.observeJobs();
    expect(listing.items.map((job) => [job.id, job.status])).toEqual([[1, "in_progress"]]);
  });

  test("two rows disagreeing about a runner's status make the listing partial", async () => {
    // `status` looks mergeable like `busy`, but the direction is inverted:
    // `online` is the value that licenses an immediate shrink, so resolving a
    // disagreement toward `online` picks the permissive reading. Preferring
    // `offline` is not right either — it would overstate the staffing
    // shortfall. Neither reading is safe in both directions, so the listing has
    // to admit it does not know.
    const row = (id: number, status: string) => ({
      id,
      name: `r${id}`,
      status,
      busy: false,
      labels: [{ name: "self-hosted" }, { name: "runner-default" }],
    });
    const page1 = Array.from({ length: 100 }, (_, i) => row(i + 1, "online"));
    const instance = new GitHubAppClient({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      org: "example-org",
      repos: ["example-org/infra"],
      now: () => NOW,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/access_tokens")) {
          return Response.json({ token: "t", expires_at: new Date(NOW + 3_600_000).toISOString() });
        }
        const which = Number(url.searchParams.get("page") ?? "1");
        // 100 distinct runners, so the count check is satisfied and the status
        // conflict on runner 1 is the only thing left that can make it partial.
        return Response.json({ total_count: 100, runners: which === 1 ? page1 : [row(1, "offline")] });
      },
    });

    const listing = await instance.observeRunners();
    expect(listing.configured && listing.complete).toBe(false);
  });

  test("two rows disagreeing about a runner's labels make the listing partial", async () => {
    // `busy` can be merged because either reading alone justifies refusing to
    // shrink. Labels cannot: they decide which pool the refusal protects. OR-ing
    // busy while keeping the first row's labels sends the block to one pool and
    // lets the other scale down on evidence that was never about it.
    const row = (id: number, labels: string[], busy: boolean) => ({
      id,
      name: `r${id}`,
      status: "online",
      busy,
      labels: labels.map((name) => ({ name })),
    });
    // A full first page, or the client stops and never sees the second.
    const page1 = [
      row(1, ["self-hosted", "a"], false),
      ...Array.from({ length: 99 }, (_, i) => row(i + 2, ["self-hosted", "a"], false)),
    ];
    const instance = new GitHubAppClient({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      org: "example-org",
      repos: ["example-org/infra"],
      now: () => NOW,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/access_tokens")) {
          return Response.json({ token: "t", expires_at: new Date(NOW + 3_600_000).toISOString() });
        }
        const which = Number(url.searchParams.get("page") ?? "1");
        // `total_count: 100` matters: 100 distinct runners are seen, so the
        // count check is satisfied and the label conflict on runner 1 is the
        // only thing left that can make this listing partial. With a larger
        // total the test would pass for the wrong reason.
        return Response.json({
          total_count: 100,
          runners: which === 1 ? page1 : [row(1, ["self-hosted", "b"], true)],
        });
      },
    });

    const listing = await instance.observeRunners();
    expect(listing.configured && listing.complete).toBe(false);
  });

  test("a falling total_count does not erase the earlier evidence of a missing row", async () => {
    // Page 1 says 101 rows exist and returns 100. Page 2 says 100 and repeats
    // one. Keeping only the latest total makes the listing look whole, when in
    // fact membership changed mid-read and the row banto never saw may be the
    // busy one. The larger total is kept, and the disagreement is itself a gap.
    const row = (id: number) => ({
      id,
      name: `r${id}`,
      status: "online",
      busy: false,
      labels: [{ name: "self-hosted" }, { name: "runner-default" }],
    });
    const first = Array.from({ length: 100 }, (_, i) => row(i + 1));
    const instance = new GitHubAppClient({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      org: "example-org",
      repos: ["example-org/infra"],
      now: () => NOW,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/access_tokens")) {
          return Response.json({ token: "t", expires_at: new Date(NOW + 3_600_000).toISOString() });
        }
        const which = Number(url.searchParams.get("page") ?? "1");
        return which === 1
          ? Response.json({ total_count: 101, runners: first })
          : Response.json({ total_count: 100, runners: [row(100)] });
      },
    });

    const listing = await instance.observeRunners();
    expect(listing.configured && listing.complete).toBe(false);
  });

  test("one job reaching the merge from two listings keeps its running status", async () => {
    // A run can be listed under two repositories. The outer merge used an
    // unconditional set, so whichever listing finished last won — and if that
    // one called the job queued, the running barrier it was holding vanished.
    const { instance } = client({
      runs: { queued: [{ id: 100 }], in_progress: [{ id: 101 }] },
      jobs: {
        100: [{ id: 1, status: "in_progress", labels: ["self-hosted", "runner-default"] }],
        101: [{ id: 1, status: "queued", labels: ["self-hosted", "runner-default"] }],
      },
    });
    const listing = await instance.observeJobs();
    expect(listing.items.map((job) => [job.id, job.status])).toEqual([[1, "in_progress"]]);
  });

  test("a page that repeats a runner does not count as having seen a new one", async () => {
    // GitHub paginates by offset. A runner registering or de-registering
    // between two page fetches shifts the window, so a row can repeat while a
    // different runner is never returned at all — and `total_count` still
    // equals the number of rows read. Counting rows would call that complete,
    // and "complete" is exactly what permits a scale-down. The unseen runner
    // here is the busy one.
    const page = (id: number, busy: boolean) => ({
      id,
      name: `r${id}`,
      status: "online",
      busy,
      labels: [{ name: "self-hosted" }, { name: "runner-default" }],
    });
    const first = Array.from({ length: 100 }, (_, i) => page(i + 1, false));
    const instance = new GitHubAppClient({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      org: "example-org",
      repos: ["example-org/infra"],
      now: () => NOW,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/access_tokens")) {
          return Response.json({ token: "t", expires_at: new Date(NOW + 3_600_000).toISOString() });
        }
        // 101 runners exist; #101 is busy and is never returned.
        const which = Number(url.searchParams.get("page") ?? "1");
        return Response.json({ total_count: 101, runners: which === 1 ? first : [page(100, false)] });
      },
    });

    const listing = await instance.observeRunners();
    const items = listing.configured ? listing.items : [];
    expect(items.length).toBe(100);
    expect(new Set(items.map((r) => r.id)).size).toBe(100);
    expect(items.some((r) => r.busy)).toBe(false);
    // The listing must admit it is short, or the busy runner it never saw
    // cannot block anything.
    expect(listing.configured && listing.complete).toBe(false);
  });

  test("a listing without the expected array is incomplete, not empty", async () => {
    // "No runners" and "the response did not say" must not look alike: the
    // first licenses a scale-down, the second is an absence of evidence.
    const instance = new GitHubAppClient({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      org: "example-org",
      repos: ["example-org/infra"],
      now: () => NOW,
      fetchImpl: async (input) => {
        if (String(input).includes("/access_tokens")) {
          return Response.json({ token: "t", expires_at: new Date(NOW + 3_600_000).toISOString() });
        }
        return Response.json({ message: "Bad credentials" });
      },
    });
    const listing = await instance.observeRunners();
    expect(listing).toEqual({ configured: true, items: [], complete: false });
  });
});

describe("repository names are never trusted", () => {
  test("a traversal segment is rejected, not requested", async () => {
    // `../repo` would turn a repository listing into a request to a path banto
    // never meant to reach.
    expect(isSafeRepoName("owner/repo")).toBe(true);
    expect(isSafeRepoName("owner/.github")).toBe(true);
    expect(isSafeRepoName("../repo")).toBe(false);
    expect(isSafeRepoName("owner/..")).toBe(false);
    expect(isSafeRepoName("./repo")).toBe(false);
    expect(isSafeRepoName("owner/repo/extra")).toBe(false);
    expect(isSafeRepoName("owner/re po")).toBe(false);
    expect(isSafeRepoName("owner%2Frepo")).toBe(false);
  });

  test("an unusable name from the installation listing marks the evidence incomplete", async () => {
    // Skipping it silently would look like "that repository has no jobs".
    const calls: string[] = [];
    const instance = new GitHubAppClient({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      now: () => NOW,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/access_tokens")) {
          return Response.json({ token: "t", expires_at: new Date(NOW + 3_600_000).toISOString() });
        }
        calls.push(url.pathname);
        if (url.pathname === "/installation/repositories") {
          return Response.json({ repositories: [{ full_name: "../evil" }, { full_name: "owner/fine" }] });
        }
        return Response.json({ workflow_runs: [] });
      },
    });
    const listing = await instance.observeJobs();
    expect(listing.complete).toBe(false);
    expect(calls.some((path) => path.includes(".."))).toBe(false);
    expect(calls.some((path) => path.startsWith("/repos/owner/fine/"))).toBe(true);
  });

  test("the rate limit headers are tracked so the budget is visible", async () => {
    // Every pass spends the installation's budget; an exhausted limit stops
    // banto staffing anything, so it must be observable before it happens.
    const instance = new GitHubAppClient({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      repos: ["owner/repo"],
      now: () => NOW,
      fetchImpl: async (input) => {
        if (String(input).includes("/access_tokens")) {
          return Response.json({ token: "t", expires_at: new Date(NOW + 3_600_000).toISOString() });
        }
        return Response.json(
          { workflow_runs: [] },
          { headers: { "x-ratelimit-remaining": "120", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1700003600" } },
        );
      },
    });
    expect(instance.rateLimit()).toBeNull();
    await instance.observeJobs();
    expect(instance.rateLimit()).toEqual({ remaining: 120, limit: 5000, resetAt: 1_700_003_600_000 });
  });
});
