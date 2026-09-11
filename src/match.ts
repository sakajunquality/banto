import type { PoolConfig } from "./types.ts";

/**
 * Pick the pool a job belongs to.
 *
 * A pool matches when every label in its selector is present on the job.
 * GitHub label matching is case-insensitive, so ours is too.
 *
 * Several pools can match at once (a `["self-hosted"]` pool and a
 * `["self-hosted","runner-build"]` pool both match a build job). The most
 * specific selector wins — the one with the most labels — because a narrower
 * selector is the more deliberate statement about where the job should run.
 * Ties (two selectors of the same size, both matching) are broken by
 * configuration order, so the resolution is deterministic and a human can fix
 * it by reordering. A job that matches no pool is not ours: it is ignored.
 */
export function selectPool(pools: readonly PoolConfig[], jobLabels: readonly string[]): PoolConfig | null {
  const have = new Set(jobLabels.map((l) => l.toLowerCase()));
  let best: PoolConfig | null = null;
  for (const pool of pools) {
    if (!pool.labels.every((l) => have.has(l.toLowerCase()))) continue;
    if (best === null || pool.labels.length > best.labels.length) best = pool;
  }
  return best;
}
