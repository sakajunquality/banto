"""Omit the etag from the scaling write, making it unconditional.

Cloud Run treats the etag as optional, so an omitted precondition is a
last-writer-wins update rather than a rejected one. The model's Cloud Run fake
treats an empty etag the same way the API does — it accepts the write — so this
measures the real consequence of dropping the precondition, not the consequence
of sending a stale one.
"""
import pathlib
p = pathlib.Path('src/controller.ts'); s = p.read_text()
s = s.replace(
    '''      await this.deps.workerPools.setInstanceCount(pool, decision.target, etag);''',
    '''      await this.deps.workerPools.setInstanceCount(pool, decision.target, "");''',
)
p.write_text(s)
