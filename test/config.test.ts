import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { ConfigError, DEFAULT_COOLDOWN_SECONDS, loadConfig, normalisePem } from "../src/config.ts";

const POOLS = JSON.stringify([
  {
    name: "default",
    project: "my-runners-prd",
    location: "asia-northeast1",
    workerPool: "gh-runner-default",
    labels: ["self-hosted", "runner-default"],
    min: 0,
    max: 5,
  },
]);

// A real (throwaway) key: config now loads the PEM rather than trusting it.
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const BASE = {
  GITHUB_WEBHOOK_SECRET: "secret",
  BANTO_POOLS: POOLS,
  GH_APP_ID: "123456",
  GH_APP_INSTALLATION_ID: "98765432",
  GH_APP_PRIVATE_KEY: PEM,
  BANTO_RECONCILE_AUDIENCE: "https://banto-xyz.a.run.app",
  BANTO_RECONCILE_ALLOWED_EMAILS: "banto-scheduler@my-runners-prd.iam.gserviceaccount.com",
  BANTO_GCS_BUCKET: "my-banto-state-prd",
  BANTO_FIRESTORE_PROJECT: "my-runners-prd",
};

describe("serverless jobs configuration", () => {
  function configured(overrides: Record<string, unknown> = {}) {
    return { ...BASE, BANTO_POOLS: JSON.stringify([{ name: "jobs", backend: "jobs", job: "runner",
      project: "test-project", location: "us-central1", max: 3, labels: ["self-hosted", "jobs"],
      runnerRepo: "example-org/infra", ...overrides }]) };
  }
  test("accepts a jobs pool without a worker pool and defaults to no warm capacity", () => {
    const config = loadConfig(configured());
    expect(config.pools[0]).toMatchObject({ backend: "jobs", job: "runner", min: 0, warmSpare: 0, idleTimeoutSeconds: 120 });
    expect(config.pools[0]?.workerPool).toBeUndefined();
  });
  for (const [overrides, error] of [
    [{ workerPool: "runner" }, "cannot also set workerPool"],
    [{ job: "../other" }, "job must be"],
    [{ min: 1 }, "requires min=0"],
    [{ warmSpare: 1 }, "requires min=0"],
    [{ scaleDown: "idle" }, "retire through completion"],
    [{ idleTimeoutSeconds: 0 }, "idleTimeoutSeconds must be"],
    [{ runnerGroupId: 0 }, "runnerGroupId must be"],
  ] as const) {
    test(`rejects incompatible jobs configuration: ${Object.keys(overrides)[0]}`, () => {
      expect(problems(configured(overrides)).join()).toContain(error);
    });
  }
  test("requires durable state and a registration scope", () => {
    expect(problems({ ...configured(), BANTO_STORE: "memory" }).join()).toContain("durable");
    expect(problems(configured({ runnerRepo: undefined })).join()).toContain("runnerRepo or GITHUB_ORG");
  });
});

function problems(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}

describe("configuration", () => {
  test("accepts a complete configuration and applies the defaults", () => {
    const config = loadConfig(BASE);
    expect(config.port).toBe(8080);
    expect(config.store).toBe("gcs");
    expect(config.firestore.database).toBe("(default)");
    expect(config.firestore.collection).toBe("banto-pools");
    expect(config.pools[0]?.cooldownSeconds).toBe(DEFAULT_COOLDOWN_SECONDS);
    expect(config.pools[0]?.scaleDown).toBe("disabled");
    expect(config.minPassIntervalMs).toBe(10_000);
    expect(config.pools[0]?.labels).toEqual(["self-hosted", "runner-default"]);
  });

  test("reports every problem at once rather than the first", () => {
    const found = problems({});
    expect(found.length).toBeGreaterThan(3);
    expect(found.join("\n")).toContain("GITHUB_WEBHOOK_SECRET is required");
    expect(found.join("\n")).toContain("BANTO_POOLS is required");
    expect(found.join("\n")).toContain("GH_APP_ID is required");
    expect(found.join("\n")).toContain("BANTO_GCS_BUCKET is required");
  });

  test("accepts disabling scale-down per pool", () => {
    const pools = JSON.parse(POOLS);
    pools[0].scaleDown = "disabled";
    expect(loadConfig({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).pools[0]?.scaleDown).toBe("disabled");
  });

  test("requires an explicit opt-in to idle scale-down", () => {
    const pools = JSON.parse(POOLS);
    pools[0].scaleDown = "idle";
    expect(loadConfig({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).pools[0]?.scaleDown).toBe("idle");
  });

  test("rejects invalid scale-down policies rather than enabling reductions", () => {
    for (const value of ["disable", "", true, 0, null]) {
      const pools = JSON.parse(POOLS);
      pools[0].scaleDown = value;
      expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).join()).toContain("scaleDown must be");
    }
  });

  test("rejects BANTO_POOLS that is not JSON", () => {
    expect(problems({ ...BASE, BANTO_POOLS: "{oops" }).join()).toContain("not valid JSON");
  });

  test("rejects an empty pool list", () => {
    expect(problems({ ...BASE, BANTO_POOLS: "[]" }).join()).toContain("non-empty JSON array");
  });

  test("requires the fields a pool cannot be guessed from", () => {
    const found = problems({ ...BASE, BANTO_POOLS: JSON.stringify([{ name: "x" }]) });
    expect(found.join("\n")).toContain("project is required");
    expect(found.join("\n")).toContain("location is required");
    expect(found.join("\n")).toContain("workerPool is required");
    expect(found.join("\n")).toContain("labels must be a non-empty array");
    expect(found.join("\n")).toContain("max is required");
  });

  test("rejects max below min", () => {
    const pools = JSON.parse(POOLS);
    pools[0].min = 4;
    pools[0].max = 2;
    expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).join()).toContain("is below min");
  });

  test("rejects a negative or fractional bound", () => {
    const pools = JSON.parse(POOLS);
    pools[0].min = -1;
    expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).join()).toContain("non-negative integer");
  });

  test("rejects two pools with the same name", () => {
    const pools = [...JSON.parse(POOLS), ...JSON.parse(POOLS)];
    expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).join()).toContain("more than one pool");
  });

  test("defaults a pool name to its worker pool name", () => {
    const pools = JSON.parse(POOLS);
    delete pools[0].name;
    expect(loadConfig({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).pools[0]?.name).toBe("gh-runner-default");
  });

  test("always requires a reconcile audience", () => {
    // There is no mode where banto trusts an unverified caller: the webhook
    // makes the service public, so nothing outside it can protect /reconcile.
    expect(problems({ ...BASE, BANTO_RECONCILE_AUDIENCE: undefined }).join()).toContain(
      "BANTO_RECONCILE_AUDIENCE is required",
    );
  });

  test("rejects an unknown store", () => {
    expect(problems({ ...BASE, BANTO_STORE: "redis" }).join()).toContain("BANTO_STORE");
    expect(problems({ ...BASE, BANTO_STORE: "gcs", BANTO_GCS_BUCKET: undefined }).join()).toContain(
      "BANTO_GCS_BUCKET is required",
    );
    expect(problems({ ...BASE, BANTO_GCS_BUCKET: "gs://bucket/path" }).join()).toContain("is not a bucket name");
  });

  test("rejects a GITHUB_REPOS entry that is not owner/repo", () => {
    expect(problems({ ...BASE, GITHUB_REPOS: "example-org/infra, nope" }).join()).toContain("is not owner/repo");
    // Startup must refuse exactly what the client would refuse later. These
    // passed the old startup check and were then rejected when the name was
    // put in a URL, so the repository quietly contributed no demand.
    for (const bad of ["../repo", "owner/..", "./repo", "owner/re po", "a/b/c"]) {
      expect(problems({ ...BASE, GITHUB_REPOS: bad }).join()).toContain("is not owner/repo");
    }
    // A repository listed twice is fetched twice and merged from two
    // directions. The merge survives it; there is no reason to configure it.
    expect(problems({ ...BASE, GITHUB_REPOS: "example-org/infra,example-org/infra" }).join()).toContain(
      "more than once",
    );
  });

  test("values that end up in a request path are validated too", () => {
    // These two were interpolated into URLs without the checks every other path
    // component gets, so a typo became a silently wrong query rather than a
    // startup error.
    for (const bad of ["../../evil", "org/sub", "has space", "-leading", ""]) {
      if (bad === "") continue;
      expect(problems({ ...BASE, GITHUB_ORG: bad }).join()).toContain("GITHUB_ORG");
    }
    for (const bad of ["../../other", "a/b", "has space"]) {
      expect(problems({ ...BASE, BANTO_FIRESTORE_COLLECTION: bad }).join()).toContain("BANTO_FIRESTORE_COLLECTION");
    }
    expect(problems({ ...BASE, GITHUB_ORG: "example-org" })).toEqual([]);
    expect(loadConfig({ ...BASE, GITHUB_REPOS: "example-org/infra, example-org/app" }).github.repos).toEqual([
      "example-org/infra",
      "example-org/app",
    ]);
  });

  test("rejects a port that is not a port", () => {
    expect(problems({ ...BASE, PORT: "http" }).join()).toContain("PORT must be a TCP port");
    expect(loadConfig({ ...BASE, PORT: "9090" }).port).toBe(9090);
  });

  test("falls back to GOOGLE_CLOUD_PROJECT for the Firestore project", () => {
    const config = loadConfig({
      ...BASE,
      BANTO_STORE: "firestore",
      BANTO_FIRESTORE_PROJECT: undefined,
      GOOGLE_CLOUD_PROJECT: "some-project",
    });
    expect(config.firestore.project).toBe("some-project");
  });

  test("accepts a PEM whose newlines survived only as escapes", () => {
    const escaped = PEM.replaceAll("\n", "\\n");
    expect(loadConfig({ ...BASE, GH_APP_PRIVATE_KEY: escaped }).github.privateKey).toContain("\n");
    expect(normalisePem("already\nreal")).toBe("already\nreal");
  });

  test("rejects a private key that is not a key", () => {
    expect(problems({ ...BASE, GH_APP_PRIVATE_KEY: "not a PEM" }).join()).toContain("not a private key");
  });

  test("rejects a non-numeric installation id", () => {
    expect(problems({ ...BASE, GH_APP_INSTALLATION_ID: "org-name" }).join()).toContain("must be numeric");
  });

  test("requires an allowlist, because an audience is not a permission", () => {
    expect(problems({ ...BASE, BANTO_RECONCILE_ALLOWED_EMAILS: undefined }).join()).toContain(
      "BANTO_RECONCILE_ALLOWED_EMAILS is required",
    );
  });

  test("rejects a pool name that is not usable as a storage key", () => {
    const pools = JSON.parse(POOLS);
    pools[0].name = "team/default";
    expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).join()).toContain("storage key");
  });
});

describe("warm spare and pass interval", () => {
  test("default to no spare", () => {
    expect(loadConfig(BASE).pools[0]?.warmSpare).toBe(0);
  });

  test("warmSpare is read from the pool entry when given", () => {
    const pools = JSON.parse(POOLS);
    pools[0].warmSpare = 2;
    expect(loadConfig({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).pools[0]?.warmSpare).toBe(2);
  });

  test("the pass interval is configurable and validated", () => {
    // Every pass spends GitHub API budget, so this is the knob that bounds it.
    expect(loadConfig({ ...BASE, BANTO_MIN_PASS_INTERVAL_SECONDS: "30" }).minPassIntervalMs).toBe(30_000);
    expect(loadConfig({ ...BASE, BANTO_MIN_PASS_INTERVAL_SECONDS: "0" }).minPassIntervalMs).toBe(0);
    expect(problems({ ...BASE, BANTO_MIN_PASS_INTERVAL_SECONDS: "-5" }).join()).toContain(
      "BANTO_MIN_PASS_INTERVAL_SECONDS",
    );
  });

  test("reject a spare that could never exist", () => {
    const pools = JSON.parse(POOLS);
    pools[0].warmSpare = 9;
    expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).join()).toContain("exceeds max");
  });

  test("carries the org used for the runner cross-check", () => {
    expect(loadConfig({ ...BASE, GITHUB_ORG: "example-org" }).github.org).toBe("example-org");
    expect(loadConfig(BASE).github.org).toBe("");
  });

  test("a pool may declare where its own runners register", () => {
    const pools = JSON.parse(POOLS);
    pools[0].runnerRepo = "example-org/repo-scoped";
    // No GITHUB_ORG at all: a repo-scoped pool does not need one.
    expect(loadConfig({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).pools[0]?.runnerRepo).toBe(
      "example-org/repo-scoped",
    );
  });

  test("a pool with no runnerRepo carries none, unchanged from before the field existed", () => {
    expect(loadConfig(BASE).pools[0]?.runnerRepo).toBeUndefined();
  });

  test("rejects a runnerRepo that is not owner/repo", () => {
    // The same predicate GITHUB_REPOS entries get, and for the same reason: a
    // name that passed a looser check here and was rejected later by the
    // client would silently cross-check nothing for that pool.
    for (const bad of ["../repo", "owner/..", "nope", "owner/re po", "a/b/c"]) {
      const pools = JSON.parse(POOLS);
      pools[0].runnerRepo = bad;
      expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).join()).toContain("is not owner/repo");
    }
  });

  test("rejects an empty runnerRepo rather than treating it as unset", () => {
    const pools = JSON.parse(POOLS);
    pools[0].runnerRepo = "";
    expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).join()).toContain(
      "runnerRepo must be a non-empty string",
    );
  });
});

describe("two pools cannot share one worker pool", () => {
  test("rejects the same project/location/workerPool under two names", () => {
    // Each would keep its own demand and cooldown, both would decide correctly
    // for themselves, and the two would fight over one instance count.
    const pools = JSON.parse(POOLS);
    pools.push({ ...pools[0], name: "second", labels: ["self-hosted", "other"] });
    const found = problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).join("\n");
    expect(found).toContain("targets the same worker pool");
    expect(found).toContain("gh-runner-default");
  });

  test("accepts the same name in different projects or regions", () => {
    const pools = JSON.parse(POOLS);
    pools.push({ ...pools[0], name: "second", project: "other-project", labels: ["self-hosted", "other"] });
    expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) })).toEqual([]);
  });
});

describe("a pool's address must mean exactly what it says", () => {
  function withPool(overrides: Record<string, unknown>): string[] {
    const pools = JSON.parse(POOLS);
    pools[0] = { ...pools[0], ...overrides };
    return problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) });
  }

  test("a traversal in the worker pool name is rejected", () => {
    // `other/../runner` resolves to the same Cloud Run resource as `runner`,
    // while comparing as a different target — so two pools would scale one
    // worker pool against each other, each decision correct on its own.
    expect(withPool({ workerPool: "other/../runner" }).join()).toContain("not a worker pool name");
    expect(withPool({ workerPool: "../runner" }).join()).toContain("not a worker pool name");
    expect(withPool({ workerPool: "runner/" }).join()).toContain("not a worker pool name");
  });

  test("a full resource name in a component is rejected", () => {
    expect(
      withPool({ workerPool: "projects/p/locations/asia-northeast1/workerPools/runner" }).join(),
    ).toContain("not a worker pool name");
  });

  test("case and padding are rejected rather than assumed equivalent", () => {
    expect(withPool({ workerPool: "Runner" }).join()).toContain("not a worker pool name");
    expect(withPool({ location: "Asia-Northeast1" }).join()).toContain("not a region");
  });

  test("a project number is refused, with the reason", () => {
    // It addresses the same project as the id, and banto cannot tell without
    // asking Google — so it refuses the form it cannot compare.
    const found = withPool({ project: "123456789012" }).join();
    expect(found).toContain("must be a project id");
    expect(found).toContain("cannot tell");
  });

  test("ordinary addresses are accepted", () => {
    expect(
      withPool({ project: "my-runners-prd", location: "asia-northeast1", workerPool: "gh-runner-default" }),
    ).toEqual([]);
  });

  test("two pools naming one worker pool are caught", () => {
    const pools = JSON.parse(POOLS);
    pools.push({ ...pools[0], name: "second", labels: ["self-hosted", "other"] });
    expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify(pools) }).join()).toContain("targets the same worker pool");
  });

  test("an alternative spelling of one resource cannot reach the comparison", () => {
    // The duplicate check compares addresses as text, which is only sound
    // because each component is restricted to a single spelling first. This is
    // the half that makes that true: a full resource path, a differently-cased
    // name, or padding is rejected at validation, so it can never alias its way
    // past the text comparison. The previous test copied an address unchanged,
    // so it never exercised this at all.
    const base = JSON.parse(POOLS)[0];

    // Rejected outright: these are different text for the same resource, and
    // allowing them would let two pools address one worker pool without the
    // text comparison noticing.
    for (const workerPool of [
      `projects/${base.project}/locations/${base.location}/workerPools/${base.workerPool}`,
      base.workerPool.toUpperCase(),
      `${base.workerPool}/`,
    ]) {
      const found = problems({ ...BASE, BANTO_POOLS: JSON.stringify([{ ...base, workerPool }]) });
      expect(found.join()).toContain("is not a worker pool name");
    }

    // Padding is the other way the invariant can hold: normalised on read
    // rather than refused, so the padded spelling and the bare one become the
    // same text — and two pools written that way collide, as they must.
    const padded = { ...base, name: "second", labels: ["self-hosted", "other"], workerPool: ` ${base.workerPool} ` };
    expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify([padded]) })).toEqual([]);
    expect(problems({ ...BASE, BANTO_POOLS: JSON.stringify([base, padded]) }).join()).toContain(
      "targets the same worker pool",
    );
  });
});
