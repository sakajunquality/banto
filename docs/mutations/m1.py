import pathlib
p = pathlib.Path('src/controller.ts'); s = p.read_text()
s = s.replace('''  private async runPass(pool: PoolConfig): Promise<Decision> {
    await this.respectPassInterval(pool.name);''','''  private async runPass(pool: PoolConfig, shared?: PoolEvidence): Promise<Decision> {
    await this.respectPassInterval(pool.name);''')
s = s.replace('''    const evidence = await this.gatherEvidence(pool);''','''    const evidence = shared ?? (await this.gatherEvidence(pool));''')
s = s.replace('''  private trigger(pool: PoolConfig): Promise<Decision> {''','''  private trigger(pool: PoolConfig, shared?: PoolEvidence): Promise<Decision> {''')
s = s.replace('''      const current = this.runPass(pool);''','''      const current = this.runPass(pool, shared);''')
s = s.replace('''        return this.runPass(pool);''','''        return this.runPass(pool, shared);''')
s = s.replace('''    for (const pool of this.deps.pools) {
      try {
        const decision = await this.trigger(pool);''','''    const shared = await this.gatherEvidence(this.deps.pools[0] as PoolConfig);
    for (const pool of this.deps.pools) {
      try {
        const decision = await this.trigger(pool, shared);''')
p.write_text(s)
