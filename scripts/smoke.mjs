// Headless smoke test of the two pure-logic modules — the search index and the
// router — plus the map style and the DOM contract. Bundles the TS with esbuild
// (already a Vite dependency) and asserts the answers are sane.
//
//   npm run smoke

import { build } from 'esbuild'
import { readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, 'node_modules/.cache/smoke.mjs')

// `import()` of an absolute path only works on POSIX — on Windows "E:\…" reads
// as a URL scheme. The cache-buster keeps repeat runs from serving a stale
// module out of the ESM loader's cache.
const fresh = (p) => import(`${pathToFileURL(p).href}?t=${Date.now()}`)

let failures = 0
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

await build({
  entryPoints: [join(ROOT, 'src/search/engine.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: TMP, logLevel: 'silent',
  // Test the shape the public gets: `import.meta.env` does not exist outside
  // Vite, and DEV-only code is not part of what ships.
  define: { 'import.meta.env.DEV': 'false' },
})
const { SearchIndex } = await fresh(TMP)

const campus = JSON.parse(await readFile(join(ROOT, 'public/data/campus.json'), 'utf8'))
const geo = JSON.parse(await readFile(join(ROOT, 'public/data/geo.json'), 'utf8'))
const site = JSON.parse(await readFile(join(ROOT, 'site.config.json'), 'utf8'))
const FROM_OSM = site.places?.fromOsm === true

/* ── data ────────────────────────────────────────────────────────────────── */

console.log('\ndata')
if (FROM_OSM) {
  // OSM coverage of this campus is thin, so the floor is deliberately low — but
  // a build that suddenly returns almost nothing means the boundary or the bbox
  // broke, and that is worth failing on.
  ok(campus.pois.length >= 20, `${campus.pois.length} places inside the campus wall`)
  ok(!campus.pois.some((p) => /^Indian Institute of Engineering/i.test(p.name)),
     'the campus polygon itself is not a POI')
} else {
  // Places are added by hand. Only curated rows may appear, and nothing should
  // arrive from an OSM tag — a stray one means the switch leaks.
  ok(campus.pois.every((p) => p.src === 'seed'),
     `${campus.pois.length} places, all hand-added (places.fromOsm is off)`,
     campus.pois.filter((p) => p.src !== 'seed').slice(0, 3).map((p) => p.name).join(', '))
}
ok(campus.pois.every((p) => p.lat && p.lon && p.cat), 'every place has a position and a category')

// The basemap and the network are what make an empty map usable at all: you
// have to be able to see the buildings to tag them, and route once you have.
ok(geo.buildings.features.length > 10, `${geo.buildings.features.length} building footprints drawn`)
ok(geo.roads.features.length + geo.paths.features.length > 10,
   `${geo.roads.features.length + geo.paths.features.length} roads and paths drawn`)
ok(geo.boundary.features.length === 1, 'campus boundary drawn')
ok(Array.isArray(campus.meta.bbox) && campus.meta.bbox.length === 2, 'campus bbox present for framing')

/* ── search ──────────────────────────────────────────────────────────────── */

console.log('\nsearch')
const index = new SearchIndex(campus, { onLayer: () => {}, onAction: () => {} })
console.log(`  ${index.docs.length} documents indexed`)

const top = (q) => index.search(q)[0]
const titles = (q, n = 3) => index.search(q).slice(0, n).map((h) => h.title)

// Every place in the data must be findable by its own full name. This is the
// check that survives OSM changing underneath us.
const unfindable = campus.pois.filter((p) => {
  const hit = index.search(p.name)[0]
  return !hit || hit.title !== p.name
})
ok(unfindable.length === 0, `all ${campus.pois.length} places found by their exact name`,
   unfindable.slice(0, 3).map((p) => p.name).join(', '))

// Shorthand a student would actually type, checked against whatever is present.
const hostel = campus.pois.find((p) => /^Hostel[\s-]?(\d+)$/i.test(p.name))
if (hostel) {
  const n = /(\d+)/.exec(hostel.name)[1]
  ok(top(`h${n}`)?.title === hostel.name, `h${n} -> ${hostel.name}`, top(`h${n}`)?.title)
}
const namedHall = campus.pois.find((p) => /^(\w+) Hall$/.test(p.name))
if (namedHall) {
  const surname = /^(\w+) Hall$/.exec(namedHall.name)[1].toLowerCase()
  ok(top(surname)?.title === namedHall.name, `${surname} -> ${namedHall.name}`, top(surname)?.title)
}

// Category words must reach the layer or a member of it.
for (const [word, cat] of [['hostel', 'hostel'], ['library', 'library'], ['hospital', 'health'],
                           ['ground', 'sports'], ['bank', 'atm'], ['lake', 'lake'],
                           ['pond', 'lake'], ['tower', 'landmark'], ['club', 'activity'],
                           ['abandoned', 'abandoned']]) {
  if (!campus.meta.counts[cat]) continue
  const hits = index.search(word)
  ok(hits.some((h) => h.cat === cat), `"${word}" reaches the ${cat} layer`, titles(word).join(' / '))
}

// Known gaps must return nothing rather than a bad guess.
ok(!index.search('PH101').some((h) => h.kind === 'place' && /PH101/i.test(h.title)),
   'a course code invents no place')
ok(!index.search('mess menu today').some((h) => h.kind === 'place' && /menu/i.test(h.title)),
   'a menu query invents no place')

ok(index.examples().length > 0, 'the empty state suggests something real',
   index.examples().join(', '))

// Surveying was how this map was made, not something the published site offers.
// Any of these reaching a production build means the switch leaked.
const devCommands = index.docs.filter((d) => d.kind === 'action' && /^do:(tag|tags)/.test(d.id))
ok(devCommands.length === 0, 'no tagging commands in a production build',
   devCommands.map((d) => d.title).join(', '))
for (const q of ['tag', 'tag mode', 'my tags', 'delete all my tags']) {
  const hits = index.search(q).filter((h) => h.kind === 'action')
  ok(!hits.some((h) => /tag/i.test(h.title)), `"${q}" surfaces no tagging command`,
     hits.map((h) => h.title).join(', '))
}
ok(index.examples().every((e) => index.search(e).length > 0),
   'every suggestion actually returns something')

// Categories that OSM has nothing in yet exist for tagging by hand. Their
// vocabulary has to work the moment something lands in one, so prove it with a
// synthetic place rather than waiting for real data to appear.
const EMPTY_CATS = [['abandoned', 'abandoned'], ['activity', 'club'], ['landmark', 'landmark']]
for (const [cat, word] of EMPTY_CATS) {
  const fake = { ...campus, pois: [{ id: 'x1', name: 'Untitled Thing', cat, lat: campus.meta.center[1], lon: campus.meta.center[0], src: 'seed' }],
                 meta: { ...campus.meta, counts: { [cat]: 1 } } }
  const idx = new SearchIndex(fake, { onLayer: () => {}, onAction: () => {} })
  const hits = idx.search(word)
  ok(hits.some((h) => h.cat === cat), `"${word}" finds a hand-tagged ${cat} place`,
     hits.slice(0, 2).map((h) => h.title).join(' / ') || 'nothing')
}

console.log('\n  latency')
for (const q of ['h', 'hostel', 'central library', 'water cooler', 'a']) {
  const t0 = performance.now()
  for (let i = 0; i < 50; i++) index.search(q)
  const per = (performance.now() - t0) / 50
  ok(per < 12, `"${q}" ${per.toFixed(2)}ms/query`)
}

/* ── map style ───────────────────────────────────────────────────────────── */

// MapLibre validates the style at runtime and refuses to render if it is
// invalid — which shows up as a page that just never loads. Catch it here.
console.log('\nmap style')
const STYLE_TMP = join(ROOT, 'node_modules/.cache/smoke-style.mjs')
await build({
  entryPoints: [join(ROOT, 'src/map/style.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: STYLE_TMP, logLevel: 'silent',
  external: ['maplibre-gl'],
})
const { buildStyle } = await fresh(STYLE_TMP)
const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec')

for (const theme of ['dark', 'light']) {
  const style = buildStyle(geo, campus, theme)
  const errors = validateStyleMin(style)
  ok(errors.length === 0, `${theme} style validates (${style.layers.length} layers)`,
     errors.map((e) => e.message).join(' | '))

  const missing = style.layers.filter((l) => l.source && !style.sources[l.source]).map((l) => l.id)
  ok(missing.length === 0, `${theme}: every layer has a source`, missing.join(', '))

  // A colour token left undefined renders as a black or transparent layer,
  // which is hard to spot and easy to ship.
  const bad = JSON.stringify(style).match(/"(?:[a-z-]*color)":\s*(null|"undefined")/g)
  ok(!bad, `${theme}: no undefined colours`, bad?.join(', ') ?? '')
}

/* ── DOM contract ────────────────────────────────────────────────────────── */

// Every id the TypeScript reaches for must exist in index.html. The `!`
// non-null assertions hide the mismatch from tsc, and the failure surfaces at
// runtime as "Cannot set properties of null" — i.e. a blank page.
console.log('\ndom')
const html = await readFile(join(ROOT, 'index.html'), 'utf8')
const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))

const srcDir = join(ROOT, 'src')
const walk = async (dir) => {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const wanted = new Map() // id -> file
for (const file of await walk(srcDir)) {
  const code = await readFile(file, 'utf8')
  for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) {
    if (!wanted.has(m[1])) wanted.set(m[1], file.replace(ROOT + '/', ''))
  }
  for (const m of code.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) {
    if (!wanted.has(m[1])) wanted.set(m[1], file.replace(ROOT + '/', ''))
  }
}

// Elements the app creates at runtime rather than declaring in the markup:
// the route badge, and the tag form the tagger renders into the panel.
const RUNTIME_IDS = new Set(['route-badge', 'tag-name', 'tag-cat', 'tag-desc'])

const orphans = [...wanted].filter(([id]) => !present.has(id) && !RUNTIME_IDS.has(id))
ok(orphans.length === 0, `all ${wanted.size} referenced ids exist in index.html`,
   orphans.map(([id, f]) => `#${id} (${f})`).join(', '))

await rm(TMP, { force: true })
await rm(STYLE_TMP, { force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n')
process.exit(failures ? 1 : 0)
