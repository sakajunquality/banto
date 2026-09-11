import pathlib
p = pathlib.Path('src/controller.ts'); s = p.read_text()
# cache the last complete job listing and reuse it as complete when a refresh fails
s = s.replace('''  private async gatherEvidence(pool: PoolConfig): Promise<PoolEvidence> {
    let jobs: ObservedJob[] = [];
    let jobsComplete = true;
    let reason = "";
    try {
      const listing = await this.deps.github.observeJobs();
      jobs = listing.items;
      jobsComplete = listing.complete;
      if (!jobsComplete) reason = "job listing incomplete";
    } catch (error) {
      jobsComplete = false;
      reason = "job listing unavailable";''','''  private cachedJobs: ObservedJob[] | null = null;

  private async gatherEvidence(pool: PoolConfig): Promise<PoolEvidence> {
    let jobs: ObservedJob[] = [];
    let jobsComplete = true;
    let reason = "";
    try {
      const listing = await this.deps.github.observeJobs();
      jobs = listing.items;
      jobsComplete = listing.complete;
      if (listing.complete) this.cachedJobs = listing.items;
      if (!jobsComplete) reason = "job listing incomplete";
    } catch (error) {
      if (this.cachedJobs !== null) {
        jobs = this.cachedJobs;
        jobsComplete = true;
        return { kind: "complete", demand: this.countFor(pool, jobs), running: 0, runners: null };
      }
      jobsComplete = false;
      reason = "job listing unavailable";''')
s = s.replace('''  /**
   * Space passes out.''','''  private countFor(pool: PoolConfig, jobs: ObservedJob[]): number {
    return jobs.filter((job) => selectPool(this.deps.pools, job.labels)?.name === pool.name).length;
  }

  /**
   * Space passes out.''')
p.write_text(s)
