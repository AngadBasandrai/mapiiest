// Headless smoke test of the two pure-logic modules — the search index and the
// router — plus the map style and the DOM contract. Bundles the TS with esbuild
// (already a Vite dependency) and asserts the answers are sane.
//
//   npm run smoke

import { build } from 'esbuild'
import { readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CURATED = join(ROOT, 'data/curated')
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
  // `import.meta.env` does not exist outside Vite; esbuild needs a value.
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

// The basemap and the network are what make an empty map usable at all.
// Buildings are deliberately NOT in here: the OSM footprints were dropped in
// favour of the outlines the survey traces onto the imagery, so a `buildings`
// layer coming back means the build started emitting them again.
ok(!geo.buildings, 'no OSM building layer is shipped',
   geo.buildings ? `${geo.buildings.features.length} came back` : '')
ok(geo.roads.features.length + geo.paths.features.length > 10,
   `${geo.roads.features.length + geo.paths.features.length} roads and paths drawn`)
ok(geo.boundary.features.length === 1, 'campus boundary drawn')
ok(Array.isArray(campus.meta.bbox) && campus.meta.bbox.length === 2, 'campus bbox present for framing')

/* ── survey area ─────────────────────────────────────────────────────────── */

// The wall stopped being the edge of the map when the survey went into the
// locality. `area` is what replaced it as the filter, and the app fences
// panning to it — if it ever came back smaller than the campus itself, every
// place outside would be silently dropped by the next build.
console.log('\nsurvey area')
{
  const { bbox, area } = campus.meta
  ok(Array.isArray(area) && area.length === 2, 'survey area present')
  ok(area[0][0] < bbox[0][0] && area[0][1] < bbox[0][1] &&
     area[1][0] > bbox[1][0] && area[1][1] > bbox[1][1],
     'the survey area strictly contains the campus bbox',
     `campus ${bbox[0]}..${bbox[1]} / area ${area[0]}..${area[1]}`)

  const km = (site.survey?.radiusKm ?? 1)
  const gotKm = (area[1][1] - bbox[1][1]) * 111.32
  ok(Math.abs(gotKm - km) < 0.05, `the ring is ${gotKm.toFixed(2)} km, asked for ${km}`)

  // Every place has to be inside it, or the build let something through that
  // the app will happily draw and never let you pan back to.
  const outside = campus.pois.filter((p) =>
    p.lon < area[0][0] || p.lon > area[1][0] || p.lat < area[0][1] || p.lat > area[1][1])
  ok(outside.length === 0, `all ${campus.pois.length} places are inside the survey area`,
     outside.slice(0, 3).map((p) => p.name).join(', '))
}

/* ── categories ──────────────────────────────────────────────────────────── */

console.log('\ncategories')
{
  const cats = campus.categories
  const keys = Object.keys(cats)
  console.log(`  ${keys.length} tags in ${Object.keys(campus.groups ?? {}).length} groups`)

  ok(keys.every((k) => /^[a-z][a-z0-9_-]{0,23}$/.test(k)),
     'every tag key is usable in JSON and in a `cat` field',
     keys.filter((k) => !/^[a-z][a-z0-9_-]{0,23}$/.test(k)).join(', '))
  ok(keys.every((k) => cats[k].label && typeof cats[k].pin === 'boolean'),
     'every tag has a label and a pin flag')

  // The picker groups by this, and an unknown group would silently drop its
  // whole `<optgroup>` heading.
  const groups = campus.groups ?? {}
  const stray = keys.filter((k) => cats[k].group && !groups[cats[k].group])
  ok(stray.length === 0, 'every tag names a group that exists', stray.join(', '))

  // The five that never held anything are gone, and nothing still points at
  // them. This is the assertion that would catch a half-finished removal.
  const RETIRED = ['print', 'water', 'toilet', 'vending', 'transport']
  const back = RETIRED.filter((k) => cats[k])
  ok(back.length === 0, 'the unused tags stay removed', back.join(', '))

  // Every place must land in a tag that exists, or it draws an unstyled dot in
  // a layer with no legend chip — which reads as the map losing data.
  const orphans = campus.pois.filter((p) => !cats[p.cat])
  ok(orphans.length === 0, `all ${campus.pois.length} places are in a tag that exists`,
     [...new Set(orphans.map((p) => p.cat))].join(', '))
}

/* ── outlines ────────────────────────────────────────────────────────────── */

// Buildings are containers drawn as an area and nothing else, so the shape is
// the whole of what they are: a building without a valid ring renders as
// nothing at all, silently.
console.log('\noutlines')
{
  const areas = campus.pois.filter((p) => p.poly)
  const buildings = campus.pois.filter((p) => p.cat === 'building')
  console.log(`  ${areas.length} places with an outline, ${buildings.length} buildings`)

  ok(areas.every((p) => Array.isArray(p.poly) && p.poly.length >= 4),
     'every outline is a closed ring of at least 3 corners',
     areas.filter((p) => !(p.poly?.length >= 4)).map((p) => p.name).join(', '))
  ok(areas.every((p) => p.poly.every((c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite))),
     'every outline point is a finite [lon, lat] pair')
  ok(areas.every((p) => {
    const f = p.poly[0], l = p.poly[p.poly.length - 1]
    return f[0] === l[0] && f[1] === l[1]
  }), 'the build closes every ring')
  // A building with no shape draws nothing — worth failing rather than shipping.
  ok(buildings.every((p) => p.poly?.length >= 4), 'every building has an outline',
     buildings.filter((p) => !(p.poly?.length >= 4)).map((p) => p.name).join(', '))
  ok(campus.categories.building && campus.categories.building.pin === false,
     'buildings are never label-pinned')
}

/* ── palette ─────────────────────────────────────────────────────────────── */

// 39 dot categories is far past what colour alone can carry, so the palette is
// solved as a maximin problem in scripts/solve-palette.mjs rather than picked
// by eye. These assertions are what stop it drifting back: an earlier palette
// had `mess` and `canteen` on the same hex, which no amount of looking at the
// map made obvious.
console.log('\npalette')
{
  const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lin = (h) => [0, 2, 4].map((i) => s2lin(parseInt(h.slice(1 + i, 3 + i), 16) / 255))
  const oklab = (h) => {
    const [r, g, b] = lin(h)
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * q,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * q,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * q]
  }
  const dE = (x, y) => {
    const a = oklab(x), b = oklab(y)
    return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  }

  const cats = Object.entries(campus.categories)
  const colors = cats.map(([, v]) => v.color)
  ok(colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)), `${colors.length} category colours are valid hex`)

  const dupes = colors.filter((c, i) => colors.indexOf(c) !== i)
  ok(dupes.length === 0, 'no two categories share a colour', [...new Set(dupes)].join(', '))

  // `building` is excluded from the dot floor, on purpose. Every other category
  // draws a dot, where colour is doing identity work against 38 other dots. A
  // building draws no dot at all — only a fill at a fifth opacity, which each
  // building then overrides with its own tint from the scheme. The solver
  // pins its khaki and spreads the dots around it, so it is held to the same
  // floor in the combined check below rather than to a weaker one.
  const dots = cats.filter(([k]) => k !== 'building')
  const closest = (list) => {
    let worst = Infinity, pair = ''
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const d = dE(list[i][1].color, list[j][1].color)
        if (d < worst) { worst = d; pair = `${list[i][0]}/${list[j][0]}` }
      }
    return { worst, pair }
  }
  // One ground now, so one floor. The solved set reaches 11.0 across 39 dots
  // and the ceiling for a dark-only solve is 11.2, so this sits just under
  // both: tight enough that adding a 40th by hand fails here rather than on
  // the map, loose enough not to break on a re-solve that lands a tenth lower.
  // A tag added from the tag manager is *not* held to this — the form warns
  // about a clash and lets it through, because a survey stopping to argue
  // about colour is worse than two dots that look alike.
  const FLOOR = 10.5
  for (const [label, list] of [['dots only', dots], ['with buildings', cats]]) {
    const { worst, pair } = closest(list)
    ok(worst >= FLOOR, `${label}: closest pair ΔE ${worst.toFixed(1)} (${pair}), floor ${FLOOR}`)
  }
}

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

// The editor ships. It was behind `import.meta.env.DEV` while the survey was
// thought to be finished; the survey is running again, past the wall, so the
// commands are part of the build. This index is bundled with DEV false, which
// is what makes that a real assertion rather than a dev-only one.
const EDITOR_CMDS = ['do:tag-mode', 'do:places', 'do:tags', 'do:tags-clear']
for (const id of EDITOR_CMDS) {
  ok(index.docs.some((d) => d.kind === 'action' && d.id === id),
     `${id} is in a production build`)
}
for (const [q, want] of [['tag mode', 'do:tag-mode'], ['places', 'do:places'],
                         ['tags', 'do:tags'], ['categories', 'do:tags'],
                         ['xerox', null], ['new tag', 'do:tags']]) {
  if (!want) continue
  const hits = index.search(q).filter((h) => h.kind === 'action')
  ok(hits.some((h) => h.id === want), `"${q}" reaches ${want}`,
     hits.slice(0, 3).map((h) => h.title).join(' / ') || 'nothing')
}


ok(index.examples().every((e) => index.search(e).length > 0),
   'every suggestion actually returns something')

// Categories that OSM has nothing in yet exist for tagging by hand. Their
// vocabulary has to work the moment something lands in one, so prove it with a
// synthetic place rather than waiting for real data to appear.
const EMPTY_CATS = [['abandoned', 'abandoned'], ['activity', 'club'], ['landmark', 'landmark'],
                    ['street', 'roll'], ['tea', 'cha'], ['stationery', 'xerox'],
                    ['pharmacy', 'medicine'], ['transit', 'toto'], ['ghat', 'ghat'],
                    ['grocery', 'kirana'], ['salon', 'haircut'], ['pg', 'paying guest'],
                    ['locality', 'para'], ['hangout', 'adda']]
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

/* ── installability ─────────────────────────────────────────────────────── */

// A manifest that names an icon it does not ship is a manifest that installs
// with a blank tile, and nothing in the build fails when that happens.
console.log('\ninstall')
{
  const manifest = JSON.parse(await readFile(join(ROOT, 'public/manifest.webmanifest'), 'utf8'))
  ok(!!manifest.name && !!manifest.short_name, `named "${manifest.short_name}"`)
  ok(manifest.display === 'standalone', `display: ${manifest.display}`)
  // Relative, so one manifest serves both the project-site subpath and the
  // custom domain at the root.
  ok(!manifest.start_url.startsWith('/') && !manifest.scope.startsWith('/'),
     'start_url and scope are relative to the manifest', `${manifest.start_url} / ${manifest.scope}`)

  const sizes = manifest.icons.map((i) => i.sizes)
  ok(sizes.includes('192x192') && sizes.includes('512x512'),
     'ships the 192 and 512 icons a launcher asks for', sizes.join(', '))
  ok(manifest.icons.some((i) => i.purpose === 'maskable'),
     'ships a maskable icon, or Android crops the mark')

  const missing = []
  for (const icon of manifest.icons) {
    if (!existsSync(join(ROOT, 'public', icon.src))) missing.push(icon.src)
  }
  ok(missing.length === 0, `all ${manifest.icons.length} icon files exist`, missing.join(', '))
  ok(existsSync(join(ROOT, 'public/apple-touch-icon.png')), 'apple-touch-icon exists')

  const html = await readFile(join(ROOT, 'index.html'), 'utf8')
  ok(/<link[^>]+rel="manifest"/.test(html), 'index.html links the manifest')
  ok(/apple-mobile-web-app-capable/.test(html), 'index.html carries the iOS standalone hints')
}

/* ── origin association ──────────────────────────────────────────────────── */

// iiest.wiki claims this origin via scope_extensions so that navigations here
// stay inside that installed app. The claim only works if this side publishes
// consent, and a mismatch fails *silently* — no console warning, nothing in
// devtools, the app just stops keeping links in-window. So assert it.
console.log('\norigin association')
{
  const REL = 'public/.well-known/web-app-origin-association'
  const IDENTITY = 'https://iiest.wiki/'
  ok(existsSync(join(ROOT, REL)), `${REL} exists`)
  if (existsSync(join(ROOT, REL))) {
    const raw = await readFile(join(ROOT, REL), 'utf8')
    let parsed = null
    try { parsed = JSON.parse(raw) } catch (e) { void e }
    ok(!!parsed, 'it is valid JSON')
    const id = parsed?.web_apps?.[0]?.web_app_identity
    // Character for character, trailing slash included.
    ok(id === IDENTITY, `web_app_identity is exactly "${IDENTITY}"`, JSON.stringify(id))
    // The extension is the whole point: the path has to be exact, and a
    // .json suffix would be served at a different URL.
    ok(!REL.endsWith('.json'), 'the filename carries no extension')
  }
  // Only matters for a branch deploy — this repo uploads an artifact, so Jekyll
  // never runs — but a missing .nojekyll is how .well-known silently vanishes.
  ok(existsSync(join(ROOT, 'public/.nojekyll')), '.nojekyll guards the dot-directory')
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

for (const [label, style] of [['desktop', buildStyle(geo)], ['compact', buildStyle(geo, '/', true)]]) {
  const errors = validateStyleMin(style)
  ok(errors.length === 0, `${label} style validates (${style.layers.length} layers)`,
     errors.map((e) => e.message).join(' | '))

  const missing = style.layers.filter((l) => l.source && !style.sources[l.source]).map((l) => l.id)
  ok(missing.length === 0, `${label}: every layer has a source`, missing.join(', '))

  // A colour token left undefined renders as a black or transparent layer,
  // which is hard to spot and easy to ship.
  const bad = JSON.stringify(style).match(/"(?:[a-z-]*color)":\s*(null|"undefined")/g)
  ok(!bad, `${label}: no undefined colours`, bad?.join(', ') ?? '')

  // A source declared and never drawn is dead weight in every payload.
  const used = new Set(style.layers.map((l) => l.source).filter(Boolean))
  const orphan = Object.keys(style.sources).filter((k) => !used.has(k))
  ok(orphan.length === 0, `${label}: every source is drawn by a layer`, orphan.join(', '))
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
const RUNTIME_IDS = new Set(['route-badge', 'tag-name', 'tag-cat', 'tag-desc',
                             'tag-tint-row', 'tag-tints', 'tag-bar',
                             'cat-label', 'cat-key', 'cat-group', 'cat-pin',
                             'cat-tints', 'cat-clash', 'cat-move'])

const orphans = [...wanted].filter(([id]) => !present.has(id) && !RUNTIME_IDS.has(id))
ok(orphans.length === 0, `all ${wanted.size} referenced ids exist in index.html`,
   orphans.map(([id, f]) => `#${id} (${f})`).join(', '))

/* ── category round trip ─────────────────────────────────────────────────── */

// The seam nothing else can see. Every other assertion here reads the *built*
// campus.json; the thing that writes `data/curated/categories.json` is the tag
// manager, which lives in the browser. So write the exact shape it exports,
// rebuild for real, and check what comes out the other side — otherwise the
// only proof the vocabulary is editable is that the form does not throw.
console.log('\ncategory round trip')
{
  const FILE = join(CURATED, 'categories.json')
  const had = existsSync(FILE) ? await readFile(FILE, 'utf8') : null
  const rebuild = () => execFileSync('node', [join(ROOT, 'scripts/build-data.mjs')],
                                     { cwd: ROOT, encoding: 'utf8' })

  const payload = {
    _source: 'smoke',
    items: [
      { key: 'cyclewallah', label: 'Cycle repair wallah', color: '#2bb3b3', pin: false, group: 'moving' },
      { key: 'hangout', deleted: true },
      { key: 'tea', label: 'Cha & tiffin', color: '#ff7808', pin: true, group: 'food' },
      { key: 'building', label: 'Buildings', color: '#adb78c', pin: false, group: 'campus', area: true },
      // Both of these are rejections, and both must be *loud* ones: a key that
      // cannot go in a `cat` field, and a colour that would draw as black.
      { key: 'BAD KEY', label: 'nope', color: '#ffffff', pin: false, group: 'campus' },
      { key: 'nocolour', label: 'nope', color: 'purple', pin: false, group: 'campus' },
    ],
  }

  try {
    await writeFile(FILE, JSON.stringify(payload, null, 2))
    const out = rebuild()
    const built = JSON.parse(await readFile(join(ROOT, 'public/data/campus.json'), 'utf8'))
    const c = built.categories

    ok(c.cyclewallah?.label === 'Cycle repair wallah' && c.cyclewallah?.group === 'moving',
       'an added tag arrives in campus.json', JSON.stringify(c.cyclewallah))
    ok(!c.hangout, 'a retired built-in is gone')
    ok(c.tea?.label === 'Cha & tiffin' && c.tea?.pin === true,
       'a retuned built-in keeps the change', JSON.stringify(c.tea))
    // `area` is not on the form, so it has to survive by being carried through
    // the export — without it a retuned `building` loses its tint scheme.
    ok(c.building?.area === true, 'building keeps `area` across the round trip')
    ok(!c['BAD KEY'] && !c.nocolour, 'an unusable key and a bad colour are refused')
    ok(/unusable key/.test(out) && /no usable colour/.test(out),
       'and the build says so rather than dropping them quietly')
  } finally {
    if (had === null) await rm(FILE, { force: true })
    else await writeFile(FILE, had)
    rebuild()
  }

  const back = JSON.parse(await readFile(join(ROOT, 'public/data/campus.json'), 'utf8'))
  ok(!!back.categories.hangout && !back.categories.cyclewallah,
     'and the built-in set comes back when the file goes')
}

await rm(TMP, { force: true })
await rm(STYLE_TMP, { force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n')
process.exit(failures ? 1 : 0)
