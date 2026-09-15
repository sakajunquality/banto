import { CloudRunWorkerPoolClient } from "./cloudrun.ts";
import { CloudRunJobsClient } from "./cloudrun-jobs.ts";
import { ExecutionScaler } from "./executions.ts";
import { type BantoConfig, ConfigError, loadConfig } from "./config.ts";
import { Controller } from "./controller.ts";
import { FirestoreDemandStore } from "./firestore.ts";
import { GcsDemandStore } from "./gcs.ts";
import { GitHubAppClient } from "./github.ts";
import { AdcTokenSource } from "./google-auth.ts";
import { createLogger } from "./log.ts";
import { GoogleIdTokenVerifier } from "./oidc.ts";
import { createApp } from "./server.ts";
import { type DemandStore, MemoryDemandStore } from "./store.ts";
import { systemClock } from "./types.ts";

let loaded: BantoConfig | undefined;
try {
  loaded = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(JSON.stringify({ severity: "ERROR", message: error.message }));
    process.exit(78); // EX_CONFIG
  }
  throw error;
}
const config: BantoConfig = loaded;

const logger = createLogger(config.logLevel);
const tokens = new AdcTokenSource();

const store: DemandStore = buildStore();

function buildStore(): DemandStore {
  switch (config.store) {
    case "gcs":
      return new GcsDemandStore({
        bucket: config.gcs.bucket,
        prefix: config.gcs.prefix,
        tokens,
      });
    case "firestore":
      return new FirestoreDemandStore({
        project: config.firestore.project,
        database: config.firestore.database,
        collection: config.firestore.collection,
        tokens,
      });
    default:
      return new MemoryDemandStore();
  }
}

if (config.store === "memory") {
  logger.warn("using the in-memory demand store: state is lost on restart and wrong with more than one instance");
}

const github = new GitHubAppClient({
  appId: config.github.appId,
  installationId: config.github.installationId,
  privateKey: config.github.privateKey,
  repos: config.github.repos,
  org: config.github.org,
  maxPagesPerQuery: config.maxPagesPerQuery,
  logger,
});

const controller = new Controller({
  pools: config.pools,
  store,
  workerPools: new CloudRunWorkerPoolClient(tokens),
  executions: new ExecutionScaler({ store, client: new CloudRunJobsClient(tokens, fetch, config.maxPagesPerQuery),
    registrar: github, clock: systemClock, logger }),
  github,
  clock: systemClock,
  logger,
  minPassIntervalMs: config.minPassIntervalMs,
});

const app = createApp({
  controller,
  webhookSecret: config.webhookSecret,
  logger,
  installationId: config.github.installationId,
  allowedRepositories: config.github.repos,
  reconcileVerifier: new GoogleIdTokenVerifier({
    audience: config.reconcile.audience,
    allowedEmails: config.reconcile.allowedEmails,
  }),
});

logger.info("banto starting", {
  port: config.port,
  store: config.store,
  minPassIntervalSeconds: config.minPassIntervalMs / 1000,
  pools: config.pools.map((pool) => ({
    name: pool.name,
    backend: pool.backend ?? "worker-pool",
    job: pool.job,
    workerPool: pool.workerPool,
    location: pool.location,
    labels: pool.labels,
    min: pool.min,
    max: pool.max,
    warmSpare: pool.warmSpare,
    cooldownSeconds: pool.cooldownSeconds,
    scaleDown: pool.scaleDown,
    idleTimeoutSeconds: pool.idleTimeoutSeconds,
  })),
});

// Bun's default `idleTimeout` is 10 seconds, and a connection with a request
// in flight but no bytes sent yet counts as idle. A reconcile is handled
// inline and its listing time grows with the installation, so on the default
// the socket would be closed under a pass that is still working — the caller
// sees a failure while the write may still land. The Cloud Scheduler example
// in the README allows 120s for an attempt; this sits above it. 255 is Bun's
// ceiling for this option.
export default { port: config.port, fetch: app.fetch, idleTimeout: 180 };
