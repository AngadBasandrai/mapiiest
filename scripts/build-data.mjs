// Turns data/raw/*.json (OpenStreetMap) + data/curated/*.json (hand-maintained)
// into the two files the app loads: public/data/{campus,geo}.json
//
//   node scripts/build-data.mjs
//
// Curated POIs never carry raw coordinates unless someone surveyed them. They
// can instead carry an `anchor` — the name of a real OSM feature — and get
// resolved to that feature's position here. That keeps hand-written data
// honest: if the anchor stops existing, the build says so.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'data/raw')
const CURATED = join(ROOT, 'data/curated')
const OUT = join(ROOT, 'public/data')

const SITE = JSON.parse(await readFile(join(ROOT, 'site.config.json'), 'utf8'))

const warnings = []
const warn = (m) => warnings.push(m)

/* ── categories ─────────────────────────────────────────────────────────── */
// Every POI lands in exactly one category. Order matters: first match wins.
// `pin` = drawn as a labelled marker; others are drawn only when their layer is on.

export const CATEGORIES = {
  lecture:  { label: 'Lecture halls', color: '#ffb454', pin: true },
  academic: { label: 'Depts & labs',  color: '#8ab4f8', pin: true },
  hostel:   { label: 'Halls & hostels', color: '#c792ea', pin: true },
  library:  { label: 'Libraries',     color: '#ffa657', pin: true },
  mess:     { label: 'Messes',        color: '#7ee787', pin: true },
  canteen:  { label: 'Canteens',      color: '#7ee787', pin: true },
  landmark: { label: 'Landmarks',     color: '#ffd166', pin: true },
  lake:     { label: 'Lakes & ponds', color: '#3fa7d6', pin: true },
  activity: { label: 'Clubs & activities', color: '#ff7ac8', pin: true },
  shop:     { label: 'Shops',         color: '#a5d6ff', pin: false },
  print:    { label: 'Printing',      color: '#f0883e', pin: false },
  water:    { label: 'Water coolers', color: '#56d4dd', pin: false },
  atm:      { label: 'ATMs & banks',  color: '#ffdd57', pin: false },
  cycle:    { label: 'Cycle parking', color: '#79c0ff', pin: false },
  laundry:  { label: 'Laundry',       color: '#d2a8ff', pin: false },
  health:   { label: 'Health',        color: '#ff7b72', pin: false },
  sports:   { label: 'Sports',        color: '#3fb950', pin: false },
  toilet:   { label: 'Toilets',       color: '#8b949e', pin: false },
  vending:  { label: 'Vending',       color: '#e3b341', pin: false },
  worship:  { label: 'Worship',       color: '#bc8cff', pin: false },
  transport:{ label: 'Transport',     color: '#ff9bce', pin: false },
  admin:    { label: 'Admin & help',  color: '#9ea7b3', pin: false },
  quarters: { label: 'Staff quarters',color: '#a1887f', pin: false },
  abandoned:{ label: 'Abandoned',     color: '#8b8378', pin: false },
  green:    { label: 'Parks',         color: '#2ea043', pin: false },
}

function classify(t) {
  const name = t.name || ''
  const { amenity: a, shop: s, leisure: l, office: o, healthcare: h, tourism: tr, building: b } = t

  // Abandoned wins over whatever the place used to be: a derelict lecture hall
  // is not somewhere to send someone looking for a lecture.
  if (t.abandoned || t.ruins || b === 'ruins' || t.historic === 'ruins' ||
      Object.keys(t).some((k) => k.startsWith('disused:') || k.startsWith('abandoned:')) ||
      /\b(Abandoned|Derelict|Ruins?|Condemned)\b/i.test(name)) return 'abandoned'

  // Water before greenery, or a lake inside a park polygon reads as parkland.
  if (t.natural === 'water' || t.water || t.landuse === 'reservoir' ||
      l === 'swimming_area' || /\b(Lake|Pond|Tank|Jheel|Dighi|Pukur)\b/i.test(name)) return 'lake'

  if (/^Lecture (Hall|Theatre)\b/i.test(name) || /Lecture Hall Complex/i.test(name) ||
      /^(Tutorial Block|LT[\s-]?\d)/i.test(name) || a === 'lecture_hall') return 'lecture'
  if (a === 'theatre' || a === 'cinema' || a === 'conference_centre' || /Auditorium$/i.test(name)) return 'lecture'

  if (/\bMess\b/i.test(name) || a === 'canteen') return 'mess'
  if (/\bCanteen\b/i.test(name)) return 'canteen'
  if (a === 'restaurant' || a === 'fast_food' || a === 'cafe' || a === 'ice_cream' ||
      a === 'food_court' || s === 'bakery') return 'canteen'

  if (a === 'library' || a === 'public_bookcase' || /\bLibrary\b/i.test(name)) return 'library'

  if (a === 'atm' || a === 'bank' || a === 'bureau_de_change') return 'atm'
  if (a === 'drinking_water' || t.man_made === 'water_tap' || a === 'water_point') return 'water'
  if (a === 'bicycle_parking' || a === 'bicycle_repair_station' || s === 'bicycle') return 'cycle'
  if (s === 'laundry' || s === 'dry_cleaning' || a === 'laundry' || /Laundry/i.test(name)) return 'laundry'
  if (s === 'copyshop' || a === 'printer' || /\b(xerox|photocopy|printout|print)\b/i.test(name)) return 'print'
  if (a === 'vending_machine') return 'vending'
  if (a === 'toilets') return 'toilet'
  if (a === 'place_of_worship' || /Temple|Mandir|Mosque|Masjid|Church|Gurudwara/i.test(name)) return 'worship'

  // Landmarks: the things you navigate by rather than go into. The campus
  // water towers land here, which is exactly how people give directions.
  if (t.historic || t.memorial || tr === 'attraction' || tr === 'viewpoint' ||
      ['water_tower', 'tower', 'lighthouse', 'obelisk', 'monument', 'campanile', 'flagpole']
        .includes(t.man_made) ||
      a === 'clock' || a === 'fountain' ||
      /\b(Memorial|Statue|Monument|Clock Tower|Water Tower|Gate ?\d*|Stambha)\b/i.test(name)) return 'landmark'

  // Extra-curricular: clubs, societies, and the rooms they meet in.
  if (t.club || l === 'hackerspace' || l === 'dance' ||
      a === 'arts_centre' || a === 'studio' || a === 'music_school' ||
      a === 'community_centre' || a === 'social_centre' || a === 'events_venue' ||
      o === 'association' || o === 'ngo' ||
      /\b(Club|Society|Gymkhana|Union|NCC|NSS|Cultural|Students'? Activity|Activity Centre)\b/i.test(name)) {
    return 'activity'
  }

  // OSM here tags the campus hospital as building=hospital with no amenity, so
  // the building value has to be read as well as the amenity.
  if (a === 'hospital' || a === 'clinic' || a === 'doctors' || a === 'pharmacy' ||
      a === 'dentist' || a === 'veterinary' || h ||
      b === 'hospital' || /\b(Hospital|Dispensary|Health Centre|Health Center)\b/i.test(name)) return 'health'

  if (a === 'police' || a === 'fire_station' || a === 'post_office' || a === 'townhall' ||
      o === 'security' || o === 'government' ||
      a === 'childcare' || a === 'social_facility' ||
      tr === 'guest_house' || tr === 'hotel' || /Guest House/i.test(name)) return 'admin'

  if (a === 'parking' || a === 'fuel' || a === 'charging_station' || a === 'bus_station' ||
      a === 'taxi' || a === 'bicycle_rental' || a === 'car_rental' ||
      /\bGate\b/i.test(name)) return 'transport'

  if (l === 'pitch' || l === 'sports_centre' || l === 'fitness_centre' || l === 'swimming_pool' ||
      l === 'track' || l === 'playground' || l === 'stadium' || l === 'bleachers' ||
      /\bGym\b/i.test(name)) return 'sports'
  if (l === 'park' || l === 'garden' || l === 'nature_reserve') return 'green'

  if (s || a === 'marketplace') return 'shop'

  // Halls of residence here are tagged tourism=hostel and named after former
  // principals — Downing, Slater, Wolfenden — so the tag has to lead. A bare
  // "… Hall" name is not enough on its own: Sengupta Hall is a hostel, but a
  // lecture hall or a dining hall would read the same way.
  if (tr === 'hostel' || b === 'dormitory' || a === 'dormitory' ||
      /\b(Hostel|Hall of Residence|Bhawan|Bhavan|Nivas|Niwas)\b/i.test(name)) return 'hostel'

  if (b === 'apartments' || b === 'residential' || /\b(Quarters|Staff Housing)\b/i.test(name)) return 'quarters'

  if (o === 'university' || o === 'research' || a === 'university' || a === 'research_institute' ||
      a === 'college' || a === 'school' || o === 'educational_institution' ||
      b === 'university' || b === 'college' || b === 'school' ||
      /\b(Department|Dept|Laboratory|Lab|Centre|Center|Institute|Academy|College|School|Facility|Building|Block|Complex|Wing|Workshop)\b/i.test(name)) {
    return 'academic'
  }
  if (o) return 'admin'
  return null
}

/* ── geo helpers ────────────────────────────────────────────────────────── */

const R = 6371008.8
const rad = (d) => (d * Math.PI) / 180

function centroid(geometry) {
  // Area-weighted centroid for closed rings, mean otherwise. Keeps labels
  // inside L-shaped buildings far better than a bbox centre does.
  const g = geometry.filter(Boolean)
  if (g.length < 3) {
    const lat = g.reduce((s, p) => s + p.lat, 0) / g.length
    const lon = g.reduce((s, p) => s + p.lon, 0) / g.length
    return [lon, lat]
  }
  let a = 0, cx = 0, cy = 0
  for (let i = 0; i < g.length - 1; i++) {
    const p = g[i], q = g[i + 1]
    const f = p.lon * q.lat - q.lon * p.lat
    a += f
    cx += (p.lon + q.lon) * f
    cy += (p.lat + q.lat) * f
  }
  if (Math.abs(a) < 1e-12) {
    const lat = g.reduce((s, p) => s + p.lat, 0) / g.length
    const lon = g.reduce((s, p) => s + p.lon, 0) / g.length
    return [lon, lat]
  }
  a *= 0.5
  return [cx / (6 * a), cy / (6 * a)]
}

function pointInRing(lon, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const readRaw = async (n) => JSON.parse(await readFile(join(RAW, `${n}.json`), 'utf8'))

/* ── main ───────────────────────────────────────────────────────────────── */

async function main() {
  for (const f of ['boundary', 'pois', 'buildings', 'highways', 'land']) {
    if (!existsSync(join(RAW, `${f}.json`))) {
      console.error(`missing data/raw/${f}.json — run \`npm run fetch\` first`)
      process.exit(1)
    }
  }

  const [boundary, pois, buildings, highways, land] = await Promise.all(
    ['boundary', 'pois', 'buildings', 'highways', 'land'].map(readRaw),
  )

  /* boundary ring — used to drop everything outside the campus wall */
  const bWay = boundary.elements.find((e) => e.geometry)
  if (!bWay) throw new Error('boundary.json has no geometry')
  const ring = bWay.geometry.map((p) => [p.lon, p.lat])
  const inCampus = (lon, lat) => pointInRing(lon, lat, ring)

  // Framing comes from the boundary, not from hand-tuned constants: the app
  // fits this box on load and clamps panning to a padded version of it. Get it
  // wrong and the campus opens as an island adrift in an empty viewport.
  const bbox = [
    [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1]))],
    [Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))],
  ]
  // Area-weighted centroid, which is what routing falls back to when the
  // browser will not say where you are. It has to be somewhere you could
  // actually stand, so reject it if the ring is concave enough to push it out.
  let center = centroid(bWay.geometry)
  if (!inCampus(center[0], center[1])) {
    center = [(bbox[0][0] + bbox[1][0]) / 2, (bbox[0][1] + bbox[1][1]) / 2]
    if (!inCampus(center[0], center[1])) warn('campus centre falls outside the boundary ring')
  }
  center = [+center[0].toFixed(5), +center[1].toFixed(5)]
  // The campus polygon is itself an amenity=university POI. Left in, it becomes
  // a pin labelled with the institute's full name sitting in the middle of the
  // map — the one thing nobody needs to search for.
  const BOUNDARY_ID = `w${bWay.id}`

  /* ── POIs from OSM ────────────────────────────────────────────────────── */
  const byId = new Map()

  // With `places.fromOsm` off, no place is derived from OSM tags at all: the
  // map ships as bare ground, buildings and paths, and every pin on it comes
  // from data/curated or from tag mode. The classifier below still runs for
  // building footprint tinting, and the geometry layers are untouched — this
  // only governs what becomes a searchable, routable place.
  const FROM_OSM = SITE.places?.fromOsm === true

  // `land` is in here for the lakes: they are the campus's own landmarks, and
  // they only exist in that query. Its grass and wood polygons classify to
  // nothing and drop out on their own.
  const sources = FROM_OSM ? [...pois.elements, ...buildings.elements, ...land.elements] : []

  const positionOf = (el) => {
    if (el.type === 'node') return [el.lon, el.lat]
    if (el.center) return [el.center.lon, el.center.lat]
    if (el.geometry?.length) return centroid(el.geometry)
    return null // a relation returned without geometry
  }

  for (const el of sources) {
    const t = el.tags || {}
    if (!t.name) continue

    const pos = positionOf(el)
    if (!pos) continue
    const [lon, lat] = pos
    if (!inCampus(lon, lat)) continue

    const cat = classify(t)
    if (!cat) continue

    const id = `${el.type[0]}${el.id}`
    if (id === BOUNDARY_ID || byId.has(id)) continue

    // The same real place is often a node (the amenity) inside a way (the
    // building). Prefer whichever arrives first — pois.json leads the list.
    byId.set(id, {
      id,
      name: t.name,
      cat,
      lon: +lon.toFixed(6),
      lat: +lat.toFixed(6),
      src: 'osm',
      osm: `${el.type}/${el.id}`,
      ...(t['name:en'] && t['name:en'] !== t.name ? { alt: t['name:en'] } : {}),
      ...(t.opening_hours ? { hours: t.opening_hours } : {}),
      ...(t.wheelchair ? { wheelchair: t.wheelchair } : {}),
      ...(t.phone || t['contact:phone'] ? { phone: t.phone || t['contact:phone'] } : {}),
      ...(t.website || t['contact:website'] ? { url: t.website || t['contact:website'] } : {}),
      ...(t.cuisine ? { cuisine: t.cuisine } : {}),
      ...(t.capacity ? { capacity: t.capacity } : {}),
      ...(t.covered ? { covered: t.covered } : {}),
      ...(t.operator ? { operator: t.operator } : {}),
      ...(t.description ? { desc: t.description } : {}),
      ...(t.level ? { level: t.level } : {}),
      kind: t.amenity || t.shop || t.leisure || t.office || t.healthcare ||
            t.tourism || t.man_made || t.water || t.natural || t.building || undefined,
    })
  }

  // Unnamed but useful. A cycle stand, a pond or a water tower is worth showing
  // whether or not anyone has bothered to name it — so each gets a label saying
  // what it is.
  const UNNAMED_LABELS = {
    bicycle_parking: 'Cycle parking', drinking_water: 'Drinking water',
    atm: 'ATM', toilets: 'Toilets', vending_machine: 'Vending machine',
    water_point: 'Water point', bicycle_repair_station: 'Cycle repair',
    water_tower: 'Water tower', tower: 'Tower', lighthouse: 'Tower',
    water_tap: 'Water tap', lake: 'Lake', pond: 'Pond', reservoir: 'Reservoir',
  }
  const unnamedKey = (t) =>
    (UNNAMED_LABELS[t.amenity] && t.amenity) ||
    (UNNAMED_LABELS[t.man_made] && t.man_made) ||
    (t.natural === 'water' ? (UNNAMED_LABELS[t.water] ? t.water : 'lake') : null)

  for (const el of FROM_OSM ? [...pois.elements, ...land.elements] : []) {
    const t = el.tags || {}
    if (t.name) continue
    const key = unnamedKey(t)
    if (!key) continue
    const pos = positionOf(el)
    if (!pos || !inCampus(pos[0], pos[1])) continue
    const [lon, lat] = pos
    const cat = classify(t)
    if (!cat) continue
    const id = `${el.type[0]}${el.id}`
    const label = UNNAMED_LABELS[key]
    byId.set(id, {
      id, name: label, cat, unnamed: true,
      lon: +lon.toFixed(6), lat: +lat.toFixed(6),
      src: 'osm', osm: `${el.type}/${el.id}`,
      ...(t.opening_hours ? { hours: t.opening_hours } : {}),
      ...(t.wheelchair ? { wheelchair: t.wheelchair } : {}),
      ...(t.capacity ? { capacity: t.capacity } : {}),
      ...(t.covered ? { covered: t.covered } : {}),
      ...(t.drinking_water === 'no' ? { potable: 'no' } : {}),
      kind: t.amenity || t.man_made || t.water || t.natural,
    })
  }

  /* ── curated overlay ──────────────────────────────────────────────────── */
  const curated = {}
  if (existsSync(CURATED)) {
    for (const f of (await readdir(CURATED)).filter((f) => f.endsWith('.json'))) {
      curated[f.replace(/\.json$/, '')] = JSON.parse(await readFile(join(CURATED, f), 'utf8'))
    }
  }

  // Anchor lookup: normalised name -> POI. Used to place curated records.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const anchors = new Map()
  for (const p of byId.values()) {
    const k = norm(p.name)
    // Prefer named, pin-worthy features as anchors over generic footprints.
    if (!anchors.has(k) || CATEGORIES[p.cat]?.pin) anchors.set(k, p)
  }

  function resolveAnchor(anchor, who) {
    if (!anchor) return null
    const hit = anchors.get(norm(anchor))
    if (!hit) { warn(`unresolved anchor "${anchor}" (from ${who})`); return null }
    return hit
  }

  // Curated POIs — printers, canteens, whole buildings OSM has not mapped yet.
  // Two ways to place one: `lat`/`lon` from an actual survey, or an `anchor`
  // naming an existing OSM feature to sit beside.
  let curatedCount = 0
  for (const p of curated.places?.items ?? []) {
    if (p.lat != null && p.lon != null) {
      if (!inCampus(p.lon, p.lat)) { warn(`curated "${p.id}" is outside the campus boundary`); continue }
      const { anchor, ...rest } = p
      void anchor
      byId.set(p.id, { ...rest, lat: +(+p.lat).toFixed(6), lon: +(+p.lon).toFixed(6), src: 'seed' })
      curatedCount++
      continue
    }
    const a = resolveAnchor(p.anchor, `places/${p.id}`)
    if (!a) continue
    // Deterministic jitter so several records on one anchor do not stack.
    const seed = [...p.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
    const ang = (seed % 360) * (Math.PI / 180)
    const dist = 8 + (seed % 11) // 8–18 m off the anchor
    const dLat = (dist * Math.cos(ang)) / 111320
    const dLon = (dist * Math.sin(ang)) / (111320 * Math.cos(rad(a.lat)))
    byId.set(p.id, {
      ...p,
      lat: +(a.lat + dLat).toFixed(6),
      lon: +(a.lon + dLon).toFixed(6),
      src: 'seed',
      near: a.name,
    })
    curatedCount++
  }

  const poiList = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))

  /* ── GeoJSON layers ───────────────────────────────────────────────────── */
  const fc = (features) => ({ type: 'FeatureCollection', features })
  const lineOf = (el, props) => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)]) },
  })
  const polyOf = (el, props) => {
    const c = el.geometry.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)])
    const first = c[0], last = c[c.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) c.push(first)
    return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [c] } }
  }
  const touchesCampus = (el) => el.geometry?.some((p) => inCampus(p.lon, p.lat))

  const buildingF = []
  for (const el of buildings.elements) {
    if (!el.geometry || el.geometry.length < 3 || !touchesCampus(el)) continue
    const t = el.tags || {}
    const cat = t.name ? classify(t) : null
    buildingF.push(polyOf(el, {
      name: t.name || '',
      cat: cat || '',
      levels: +(t['building:levels'] || 0) || 0,
    }))
  }

  const PATH_KINDS = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'corridor'])
  const pathF = [], roadF = []
  for (const el of highways.elements) {
    if (!el.geometry || el.geometry.length < 2 || !touchesCampus(el)) continue
    const t = el.tags || {}
    const hw = t.highway
    const props = { name: t.name || '', hw, lit: t.lit || '', surface: t.surface || '' }
    if (PATH_KINDS.has(hw)) pathF.push(lineOf(el, props))
    else roadF.push(lineOf(el, props))
  }

  const greenF = [], waterF = [], waterLineF = [], wallF = []
  for (const el of land.elements) {
    if (!el.geometry || !touchesCampus(el)) continue
    const t = el.tags || {}
    if (t.waterway) { waterLineF.push(lineOf(el, { kind: t.waterway })); continue }
    if (t.barrier) { wallF.push(lineOf(el, { kind: t.barrier })); continue }
    if (el.geometry.length < 3) continue
    if (t.natural === 'water') { waterF.push(polyOf(el, { kind: 'water' })); continue }
    const g = t.landuse || t.natural
    if (['forest', 'wood', 'grass', 'grassland', 'recreation_ground', 'orchard',
         'plant_nursery', 'meadow', 'scrub', 'village_green'].includes(g)) {
      greenF.push(polyOf(el, { kind: g }))
    }
  }
  // Sports pitches read as green space on the map.
  for (const el of pois.elements) {
    const t = el.tags || {}
    if (!['pitch', 'track', 'playground', 'garden', 'park'].includes(t.leisure)) continue
    if (!el.geometry || el.geometry.length < 3 || !touchesCampus(el)) continue
    greenF.push(polyOf(el, { kind: t.leisure }))
  }

  const geo = {
    boundary: fc([polyOf(bWay, { name: bWay.tags?.name || SITE.name })]),
    green: fc(greenF),
    water: fc(waterF),
    waterway: fc(waterLineF),
    wall: fc(wallF),
    roads: fc(roadF),
    paths: fc(pathF),
    buildings: fc(buildingF),
  }

  /* ── output ───────────────────────────────────────────────────────────── */
  const counts = {}
  for (const p of poiList) counts[p.cat] = (counts[p.cat] || 0) + 1

  const campus = {
    meta: {
      name: SITE.name,
      longName: SITE.longName,
      built: new Date().toISOString().slice(0, 10),
      center,
      bbox,
      attribution: '© OpenStreetMap contributors (ODbL)',
      osmWay: SITE.osm.campusWay,
      counts,
    },
    categories: CATEGORIES,
    pois: poiList,
    ...curated,
  }

  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, 'campus.json'), JSON.stringify(campus))
  await writeFile(join(OUT, 'geo.json'), JSON.stringify(geo))

  const kb = (o) => (JSON.stringify(o).length / 1024).toFixed(0) + ' kB'
  console.log(`places     ${poiList.length} (${poiList.length - curatedCount} osm + ${curatedCount} curated)`)
  if (!FROM_OSM) {
    console.log('  places.fromOsm is off — no places derived from OSM tags.')
    console.log('  Add them by hand in tag mode, or in data/curated/places.json.')
  }
  if (poiList.length) {
    console.log(`  ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`)
  }
  console.log(`geo        ${buildingF.length} buildings, ${pathF.length} paths, ${roadF.length} roads, ${greenF.length} green`)
  for (const k of Object.keys(curated)) {
    console.log(`curated    ${k}: ${curated[k]?.items?.length ?? 0} items`)
  }
  console.log(`output     campus ${kb(campus)}, geo ${kb(geo)}`)
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`)
    for (const w of [...new Set(warnings)].slice(0, 25)) console.log(`  ! ${w}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
