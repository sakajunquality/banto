import pathlib
p = pathlib.Path('src/decide.ts'); s = p.read_text()
s = s.replace('''  if (value > now + ANCHOR_SKEW_MS) return null;''','''  // mutation: trust a future anchor''')
p.write_text(s)
