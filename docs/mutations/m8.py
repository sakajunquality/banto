"""Cache each pool's first complete evidence and reuse it, never refetching.

Distinct from m7: that one still called the API and fell back to a cache when
the call failed. This one stops looking altogether after the first success, so
no observation is recorded for later passes — the shape that survives any
freshness check without a pass-start boundary.
"""
import pathlib
p = pathlib.Path('src/controller.ts'); s = p.read_text()
s = s.replace('''  private async gatherEvidence(pool: PoolConfig): Promise<PoolEvidence> {''','''  private cachedEvidence = new Map<string, PoolEvidence>();

  private async gatherEvidence(pool: PoolConfig): Promise<PoolEvidence> {
    const cached = this.cachedEvidence.get(pool.name);
    if (cached !== undefined) return cached;''')
s = s.replace('''    return { kind: "complete", demand, running, runners };''','''    const fresh: PoolEvidence = { kind: "complete", demand, running, runners };
    this.cachedEvidence.set(pool.name, fresh);
    return fresh;''')
p.write_text(s)
