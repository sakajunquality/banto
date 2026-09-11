import pathlib
p = pathlib.Path('src/decide.ts'); s = p.read_text()
s = s.replace('''  if (evidence.kind === "partial") {
    return { ...base, target: current, outcome: "blocked_incomplete_evidence", write: false };
  }''','''  if (evidence.kind === "partial") {
    return { ...base, target: desired, outcome: "scale_down", write: true, idleEvidence: "cooldown" };
  }''')
p.write_text(s)
