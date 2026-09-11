import pathlib
p = pathlib.Path('src/controller.ts'); s = p.read_text()
s = s.replace('''      } else if (!listing.complete) {
        return { kind: "partial", demand, reason: "runner listing incomplete" };''','''      } else if (false) {
        return { kind: "partial", demand, reason: "runner listing incomplete" };''')
p.write_text(s)
