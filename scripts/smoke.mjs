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
})
const { SearchIndex } = await fresh(TMP)

const ROUTER_TMP = join(ROOT, 'node_modules/.cache/smoke-router.mjs')
await build({
  entryPoints: [join(ROOT, 'src/route/router.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: ROUTER_TMP, logLevel: 'silent',
})
const { Router, humanEta } = await fresh(ROUTER_TMP)

const campus = JSON.parse(await readFile(join(ROOT, 'public/data/campus.json'), 'utf8'))
const graph = JSON.parse(await readFile(join(ROOT, 'public/data/graph.json'), 'utf8'))
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
ok(graph.lat.length >= 50, `${graph.lat.length} routing nodes`)
ok(graph.dropped === 0 || graph.dropped / (graph.lat.length + graph.dropped) < 0.35,
   `routing graph is mostly one component (${graph.dropped} nodes dropped)`)

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

/* ── routing ─────────────────────────────────────────────────────────────── */

console.log('\nrouting')
const router = new Router(graph)

const straightM = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 102900)

// Route between the furthest-apart pinned places rather than a hand-written
// list of names, so the test does not rot when OSM renames a building. With no
// places on the map, corners of the path network stand in for them — routing
// has to work before the first tag is placed, not after.
const pinned = campus.pois.filter((p) => campus.categories[p.cat]?.pin)
const endpoints = pinned.length >= 2
  ? pinned
  : [0, 1, 2, 3].map((q) => {
      // One node per quadrant of the network's own bounding box.
      const lats = graph.lat, lons = graph.lon
      const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
      const midLon = (Math.min(...lons) + Math.max(...lons)) / 2
      const wantN = q < 2, wantE = q % 2 === 0
      const i = lats.findIndex((la, k) =>
        (la >= midLat) === wantN && (lons[k] >= midLon) === wantE)
      return i < 0 ? null : { name: `network node ${i}`, lat: lats[i], lon: lons[i] }
    }).filter(Boolean)

const pairs = []
for (let i = 0; i < endpoints.length && pairs.length < 4; i++) {
  const a = endpoints[i]
  let far = null, d = 0
  for (const b of endpoints) {
    const m = straightM(a, b)
    if (m > d) { d = m; far = b }
  }
  if (far && d > 120) pairs.push([a, far])
}
ok(pairs.length > 0, `${pairs.length} route pairs to test`,
   pinned.length >= 2 ? 'from pinned places' : 'from the path network (no places on the map yet)')

for (const [A, B] of pairs) {
  const walk = router.route(A, B, 'foot')
  const bike = router.route(A, B, 'bike')
  if (!walk || !bike) {
    ok(false, `${A.name} -> ${B.name}`, `no route on ${!walk && !bike ? 'either profile' : !walk ? 'foot' : 'bike'}`)
    continue
  }
  const detour = walk.metres / Math.max(straightM(A, B), 1)
  ok(detour > 0.95 && detour < 3 && bike.seconds < walk.seconds,
     `${A.name} -> ${B.name}`,
     `${walk.metres}m walk ${humanEta(walk.seconds)} / cycle ${humanEta(bike.seconds)} (detour ${detour.toFixed(2)}x)`)
}

// Every pinned POI must be reachable on BOTH profiles. Checking only `foot`
// hides bugs where a building entered via an indoor corridor is unreachable
// by bike.
const centre = { lat: campus.meta.center[1], lon: campus.meta.center[0] }
for (const profile of ['foot', 'bike']) {
  const bad = pinned.filter((p) => !router.route(centre, p, profile))
  ok(bad.length === 0, `all ${pinned.length} pinned places reachable by ${profile}`,
     bad.length ? `${bad.length} unreachable, e.g. ${bad.slice(0, 3).map((p) => p.name).join(', ')}` : '')
}

// Cycling should never be slower than walking over the same pair.
const slower = pinned.slice(0, 60).filter((p) => {
  const w = router.route(centre, p, 'foot'), c = router.route(centre, p, 'bike')
  return w && c && c.seconds > w.seconds
})
ok(slower.length === 0, 'cycling never slower than walking',
   slower.length ? `${slower.length} pairs, e.g. ${slower[0].name}` : '')

const t0 = performance.now()
for (let i = 0; i < 30; i++) router.route(centre, endpoints[i % endpoints.length], 'foot')
ok((performance.now() - t0) / 30 < 40, `route latency ${((performance.now() - t0) / 30).toFixed(1)}ms`)

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
await rm(ROUTER_TMP, { force: true })
await rm(STYLE_TMP, { force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n')
process.exit(failures ? 1 : 0)
