import pathlib
p = pathlib.Path('src/controller.ts'); s = p.read_text()
s = s.replace('''      return { kind: "partial", demand, reason: "runner listing unavailable" };''','''      runners = null;''')
p.write_text(s)
