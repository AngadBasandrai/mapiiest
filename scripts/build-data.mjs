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
// `pin` = drawn as a labelled marker; others are drawn only when their layer is
// on. `group` only sorts the picker in the editor — 40 categories in one flat
// dropdown is a list nobody reads to the end of.
//
// These are the built-in set, not the whole set. data/curated/categories.json
// can add, retune or retire any of them, and the editor writes that file — so
// what ships here is a starting point for a survey rather than a fixed
// vocabulary.
//
// The colours are not hand-picked. 39 dot categories is far past the ~8 a
// categorical palette carries by hue alone, so they are solved as a maximin
// problem in scripts/solve-palette.mjs — spread as far apart as 39 colours can
// be on the map's one dark ground. The closest pair is ΔE 11.0 (OKLab ×100).
//
// That is down from 12.9 at 26 categories, and the drop is the honest price of
// the locality survey: fourteen more colours out of the same finite space. It
// is affordable because the legend only ever shows a category something is
// actually in, so the set on screen is far smaller than the set defined here.
//
// These values were solved when the app still had a light theme and scored the
// worse of the two. That theme is gone, and the palette was deliberately left
// alone: solving for the dark ground alone only reaches 11.2, so re-cutting all
// 39 hexes would buy 0.2 and cost every one of them its familiarity.
//
// What no palette can do is survive colour blindness: no set of 39 colours can,
// and the closest protan/deutan pair here is ~0. Identity never rests on colour
// alone — pinned places carry their name on the map, the legend chip names its
// category, and clicking a dot opens its name.
//
// Assignment is semantic where the spread allows it: lakes blue, parks green,
// health crimson, pharmacies the green cross an Indian chemist actually uses,
// the food group warm, quarters tan. Parks and cycle parking take two of the
// closest greens on purpose — they are a pair it costs little to confuse.

export const GROUPS = {
  campus:  'On campus',
  ground:  'Ground & landmarks',
  food:    'Food & drink',
  service: 'Shops & services',
  moving:  'Getting around',
}

export const CATEGORIES = {
  /* ── on campus ────────────────────────────────────────────────────────── */
  // Buildings are containers: departments, offices and labs sit inside one.
  // They draw as an outlined area with no dot and no label — the places inside
  // carry the names, and a building's own name on top of them would be noise.
  building:   { label: 'Buildings',            color: '#adb78c', pin: false, group: 'campus', area: true },
  academic:   { label: 'Depts & labs',         color: '#1779e1', pin: true,  group: 'campus' },
  lecture:    { label: 'Lecture halls',        color: '#c35405', pin: true,  group: 'campus' },
  library:    { label: 'Libraries',            color: '#fda19b', pin: true,  group: 'campus' },
  admin:      { label: 'Admin & help',         color: '#a5d0f6', pin: false, group: 'campus' },
  activity:   { label: 'Clubs & activities',   color: '#f1027c', pin: true,  group: 'campus' },
  hostel:     { label: 'Halls & hostels',      color: '#a56cff', pin: true,  group: 'campus' },
  quarters:   { label: 'Staff quarters',       color: '#f9ad26', pin: false, group: 'campus' },
  mess:       { label: 'Messes',               color: '#23ec1f', pin: true,  group: 'campus' },
  canteen:    { label: 'Canteens',             color: '#11c98b', pin: true,  group: 'campus' },
  sports:     { label: 'Sports',               color: '#b3f817', pin: false, group: 'campus' },
  gate:       { label: 'Gates',                color: '#a09600', pin: true,  group: 'campus' },
  abandoned:  { label: 'Abandoned',            color: '#8d83b9', pin: false, group: 'campus' },

  /* ── ground & landmarks ───────────────────────────────────────────────── */
  landmark:   { label: 'Landmarks',            color: '#85733a', pin: true,  group: 'ground' },
  lake:       { label: 'Lakes & ponds',        color: '#05a0d2', pin: true,  group: 'ground' },
  green:      { label: 'Parks & gardens',      color: '#018e01', pin: false, group: 'ground' },
  worship:    { label: 'Worship',              color: '#fe7cff', pin: false, group: 'ground' },
  // A para is the unit people actually navigate Howrah by — "meet me at
  // Kadamtala" is an address in a way that a street name is not. Pinned,
  // because the whole point of one is to be readable without being tapped.
  locality:   { label: 'Localities & paras',   color: '#d09cd7', pin: true,  group: 'ground' },
  hangout:    { label: 'Hangouts & adda',      color: '#ffcafe', pin: false, group: 'ground' },

  /* ── food & drink ─────────────────────────────────────────────────────── */
  food:       { label: 'Restaurants & dhabas', color: '#f90e12', pin: true,  group: 'food' },
  street:     { label: 'Street food & rolls',  color: '#f9667d', pin: false, group: 'food' },
  tea:        { label: 'Tea stalls & cafes',   color: '#ff7808', pin: false, group: 'food' },
  sweets:     { label: 'Sweets & bakeries',    color: '#b88472', pin: false, group: 'food' },

  /* ── shops & services ─────────────────────────────────────────────────── */
  shop:       { label: 'Shops',                color: '#6451fa', pin: false, group: 'service' },
  grocery:    { label: 'Grocery & kirana',     color: '#baca0d', pin: false, group: 'service' },
  stationery: { label: 'Stationery & xerox',   color: '#c510c4', pin: false, group: 'service' },
  pharmacy:   { label: 'Pharmacies',           color: '#7eed9e', pin: false, group: 'service' },
  health:     { label: 'Health',               color: '#b8476e', pin: false, group: 'service' },
  repair:     { label: 'Repairs & spares',     color: '#31c6d6', pin: false, group: 'service' },
  salon:      { label: 'Salons & barbers',     color: '#fe06fd', pin: false, group: 'service' },
  clothes:    { label: 'Clothes & tailors',    color: '#d061c1', pin: false, group: 'service' },
  laundry:    { label: 'Laundry',              color: '#529e74', pin: false, group: 'service' },
  market:     { label: 'Markets & bazaars',    color: '#efd3a3', pin: true,  group: 'service' },
  atm:        { label: 'ATMs & banks',         color: '#ffdd22', pin: false, group: 'service' },
  school:     { label: 'Schools & coaching',   color: '#9d05f8', pin: false, group: 'service' },
  pg:         { label: 'PG & rentals',         color: '#9353b7', pin: false, group: 'service' },

  /* ── getting around ───────────────────────────────────────────────────── */
  transit:    { label: 'Buses, autos & totos', color: '#20fcff', pin: false, group: 'moving' },
  ghat:       { label: 'Ferry ghats',          color: '#407e90', pin: true,  group: 'moving' },
  fuel:       { label: 'Petrol pumps',         color: '#83a8fd', pin: false, group: 'moving' },
  cycle:      { label: 'Cycle parking',        color: '#06b905', pin: false, group: 'moving' },
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

  // Campus catering leads, because on this side of the wall "canteen" and
  // "mess" are institutions with names rather than descriptions of a shop.
  if (/\bMess\b/i.test(name) || a === 'canteen') return 'mess'
  if (/\bCanteen\b/i.test(name)) return 'canteen'

  // Off the wall the food splits four ways, because a student chooses between
  // them and not between "food" and "not food": somewhere to sit, somewhere to
  // stand with a roll, somewhere to nurse a cha, and somewhere to buy mishti.
  if (a === 'ice_cream' || s === 'bakery' || s === 'confectionery' || s === 'pastry' ||
      s === 'chocolate' || /\b(Sweets?|Mishti|Misti|Bakery|Cake|Confectioner)\b/i.test(name)) return 'sweets'
  if (a === 'cafe' || s === 'coffee' || s === 'tea' ||
      /\b(Tea|Cha|Chai|Coffee|Tiffin|Cafe|Café)\b/i.test(name)) return 'tea'
  if (a === 'fast_food' || a === 'street_vendor' || a === 'food_court' ||
      t.street_vendor === 'yes' ||
      /\b(Roll|Rolls|Momo|Chowmein|Chow|Phuchka|Puchka|Ghugni|Telebhaja|Stall)\b/i.test(name)) return 'street'
  if (a === 'restaurant' || a === 'bar' || a === 'pub' || a === 'biergarten' ||
      /\b(Restaurant|Dhaba|Hotel & Restaurant|Biryani|Bhojanalaya)\b/i.test(name)) return 'food'

  if (a === 'library' || a === 'public_bookcase' || /\bLibrary\b/i.test(name)) return 'library'

  if (a === 'atm' || a === 'bank' || a === 'bureau_de_change') return 'atm'
  if (a === 'bicycle_parking' || a === 'bicycle_repair_station' || s === 'bicycle') return 'cycle'
  if (s === 'laundry' || s === 'dry_cleaning' || a === 'laundry' || /Laundry|Dhobi/i.test(name)) return 'laundry'
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

  // Medicine before medicine-with-a-doctor-attached: at eleven at night the
  // chemist is the thing being looked for, and it is a different errand.
  if (a === 'pharmacy' || s === 'chemist' || s === 'medical_supply' ||
      /\b(Pharmacy|Chemist|Medical Store|Medicine Shop|Drug House)\b/i.test(name)) return 'pharmacy'

  // OSM here tags the campus hospital as building=hospital with no amenity, so
  // the building value has to be read as well as the amenity.
  if (a === 'hospital' || a === 'clinic' || a === 'doctors' ||
      a === 'dentist' || a === 'veterinary' || h ||
      b === 'hospital' || /\b(Hospital|Dispensary|Health Centre|Health Center|Nursing Home|Pathology|Diagnostic)\b/i.test(name)) return 'health'

  if (a === 'police' || a === 'fire_station' || a === 'post_office' || a === 'townhall' ||
      o === 'security' || o === 'government' ||
      a === 'childcare' || a === 'social_facility' ||
      tr === 'guest_house' || tr === 'hotel' || /Guest House/i.test(name)) return 'admin'

  // A gate is a place you are told to meet at, so it leads over the road
  // furniture around it.
  if (t.barrier === 'gate' || t.barrier === 'entrance' || t.entrance ||
      /\b(Gate ?\d*|Main Gate|Back Gate|Gate No)\b/i.test(name)) return 'gate'

  // Getting around, split by what you would actually board. A ghat is not a
  // bus stop: on this bank of the Hooghly it is the fast way into Kolkata.
  if (a === 'ferry_terminal' || t.amenity === 'ferry_terminal' ||
      /\b(Ghat|Jetty|Ferry)\b/i.test(name)) return 'ghat'
  if (a === 'fuel' || a === 'charging_station' ||
      /\b(Petrol Pump|Filling Station|Fuel|HP|IOCL|BPCL)\b/i.test(name)) return 'fuel'
  if (a === 'bus_station' || t.highway === 'bus_stop' || t.public_transport ||
      a === 'taxi' || a === 'bicycle_rental' || a === 'car_rental' || a === 'parking' ||
      t.railway === 'station' || t.railway === 'halt' ||
      /\b(Bus Stop|Bus Stand|Auto Stand|Toto Stand|Taxi Stand|Station)\b/i.test(name)) return 'transit'

  if (l === 'pitch' || l === 'sports_centre' || l === 'fitness_centre' || l === 'swimming_pool' ||
      l === 'track' || l === 'playground' || l === 'stadium' || l === 'bleachers' ||
      /\bGym\b/i.test(name)) return 'sports'
  if (l === 'park' || l === 'garden' || l === 'nature_reserve') return 'green'

  /* ── the shops outside the wall ───────────────────────────────────────── */
  // `shop=*` used to fall into one bucket, which was fine when the map stopped
  // at the boundary and there were four of them. Outside it, "shop" is most of
  // what there is to map, and a student picking between a kirana and a chemist
  // is not helped by both being a purple dot.
  if (a === 'marketplace' || s === 'mall' || s === 'department_store' ||
      /\b(Bazar|Bazaar|Market|Haat|Hat)\b/i.test(name)) return 'market'
  if (s === 'convenience' || s === 'supermarket' || s === 'grocery' || s === 'general' ||
      s === 'greengrocer' || s === 'butcher' || s === 'seafood' || s === 'dairy' ||
      s === 'alcohol' || s === 'beverages' || s === 'frozen_food' || s === 'farm' ||
      /\b(Kirana|Grocer|Grocery|Provision|Stores?)\b/i.test(name)) return 'grocery'
  if (s === 'stationery' || s === 'copyshop' || s === 'books' || s === 'newsagent' ||
      s === 'printing' || a === 'printer' ||
      /\b(Xerox|Photocopy|Photostat|Printout|Stationery|Book\s?Stall|Cyber)\b/i.test(name)) return 'stationery'
  if (s === 'hairdresser' || s === 'beauty' || s === 'massage' || a === 'spa' ||
      /\b(Salon|Saloon|Barber|Parlour|Parlor)\b/i.test(name)) return 'salon'
  if (s === 'clothes' || s === 'tailor' || s === 'shoes' || s === 'fabric' ||
      s === 'boutique' || s === 'bag' || s === 'jewelry' || s === 'watches' ||
      /\b(Tailor|Darzi|Boutique|Garments?|Cloth)\b/i.test(name)) return 'clothes'
  if (s === 'mobile_phone' || s === 'electronics' || s === 'computer' || s === 'hardware' ||
      s === 'doityourself' || s === 'electrical' || s === 'car_repair' || s === 'motorcycle_repair' ||
      s === 'shoe_repair' || s === 'locksmith' || s === 'paint' || s === 'trade' ||
      a === 'mobile_money_agent' ||
      /\b(Repair|Servicing|Mechanic|Electrician|Plumber|Cobbler|Mistri|Hardware|Spare)\b/i.test(name)) return 'repair'

  // Somewhere to live is its own errand, and the words for it here are local.
  if (tr === 'apartment' ||
      /\b(P\.?G\.?|Paying Guest|Mess Bari|To[- ]?Let|Rental|Rooms? Available)\b/i.test(name)) return 'pg'

  if (a === 'school' || a === 'kindergarten' || a === 'driving_school' ||
      a === 'language_school' || a === 'training' || a === 'prep_school' ||
      /\b(Coaching|Tuition|Tutorial Home|Vidyalaya|Vidyapith|Sishu|High School)\b/i.test(name)) return 'school'

  if (s) return 'shop'

  // Halls of residence here are tagged tourism=hostel and named after former
  // principals — Downing, Slater, Wolfenden — so the tag has to lead. A bare
  // "… Hall" name is not enough on its own: Sengupta Hall is a hostel, but a
  // lecture hall or a dining hall would read the same way.
  if (tr === 'hostel' || b === 'dormitory' || a === 'dormitory' ||
      /\b(Hostel|Hall of Residence|Bhawan|Bhavan|Nivas|Niwas)\b/i.test(name)) return 'hostel'

  if (b === 'apartments' || b === 'residential' || /\b(Quarters|Staff Housing)\b/i.test(name)) return 'quarters'

  if (o === 'university' || o === 'research' || a === 'university' || a === 'research_institute' ||
      a === 'college' || o === 'educational_institution' ||
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
  // fits this box on load. Get it wrong and the campus opens as an island
  // adrift in an empty viewport. It stays the *campus* box even though places
  // now go well past it — opening on the whole survey area would frame two and
  // a half kilometres of Howrah to show a campus in the middle of it.
  const bbox = [
    [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1]))],
    [Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))],
  ]

  /**
   * The survey area: the campus plus a ring of locality around it.
   *
   * The wall used to be the edge of the world here — anything curated outside
   * it was rejected as a survey mistake, which is the right call when the whole
   * map is a campus. It is the wrong call the moment the thing being mapped is
   * where a student actually spends money: the chemist, the roll shop, the toto
   * stand and the ghat are all on the far side of it.
   *
   * So the wall stops being a filter and becomes what it really is — a line on
   * the map. This box is the filter instead, and it is still a filter: a place
   * a kilometre and a half out is a fat-fingered tap, not a discovery.
   */
  const RADIUS_KM = Number(SITE.survey?.radiusKm) || 1
  const padLat = RADIUS_KM / 111.32
  // Longitude degrees are shorter than latitude ones away from the equator.
  const padLon = padLat / Math.cos(rad((bbox[0][1] + bbox[1][1]) / 2))
  const area = [
    [+(bbox[0][0] - padLon).toFixed(5), +(bbox[0][1] - padLat).toFixed(5)],
    [+(bbox[1][0] + padLon).toFixed(5), +(bbox[1][1] + padLat).toFixed(5)],
  ]
  const inArea = (lon, lat) =>
    lon >= area[0][0] && lon <= area[1][0] && lat >= area[0][1] && lat <= area[1][1]
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
  // Only kinds that still have a category to land in: `classify` drops the
  // rest, so a label here for a retired category would be a promise the build
  // silently fails to keep.
  const UNNAMED_LABELS = {
    bicycle_parking: 'Cycle parking', bicycle_repair_station: 'Cycle repair',
    atm: 'ATM', ferry_terminal: 'Ferry ghat', fuel: 'Petrol pump',
    water_tower: 'Water tower', tower: 'Tower', lighthouse: 'Tower',
    lake: 'Lake', pond: 'Pond', reservoir: 'Reservoir',
  }
  const unnamedKey = (t) =>
    (UNNAMED_LABELS[t.amenity] && t.amenity) ||
    (UNNAMED_LABELS[t.man_made] && t.man_made) ||
    (t.highway === 'bus_stop' ? 'bus_stop' : null) ||
    (t.natural === 'water' ? (UNNAMED_LABELS[t.water] ? t.water : 'lake') : null)
  UNNAMED_LABELS.bus_stop = 'Bus stop'

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

  /**
   * The category set: the built-ins with data/curated/categories.json applied
   * on top. A row there either retunes a built-in (same key, new label, colour
   * or pin), retires one (`deleted: true`), or adds one that never existed.
   *
   * This is what makes the editor's tag manager mean anything beyond the tab
   * it was used in: it exports this file, and a rebuild makes the vocabulary
   * everyone's. Note that it is pulled out of `curated` by hand rather than
   * left to the spread below — `{ categories: CATEGORIES, ...curated }` would
   * have a categories.json silently *replace* the built-ins instead of layering
   * over them, which is a difference nobody would notice until half the map
   * turned grey.
   */
  const catEdits = curated.categories?.items ?? []
  delete curated.categories
  const categories = { ...CATEGORIES }
  let catAdded = 0, catRetired = 0, catRetuned = 0
  for (const c of catEdits) {
    if (!c?.key || !/^[a-z][a-z0-9_-]{0,23}$/.test(c.key)) {
      warn(`category "${c?.key}" has an unusable key — [a-z][a-z0-9_-]{0,23}`)
      continue
    }
    if (c.deleted) {
      if (categories[c.key]) { delete categories[c.key]; catRetired++ }
      continue
    }
    if (!/^#[0-9a-f]{6}$/i.test(c.color ?? '')) {
      warn(`category "${c.key}" has no usable colour — it would draw as a black dot`)
      continue
    }
    if (categories[c.key]) catRetuned++; else catAdded++
    categories[c.key] = {
      label: String(c.label || c.key),
      color: c.color.toLowerCase(),
      pin: c.pin === true,
      group: c.group && GROUPS[c.group] ? c.group : 'service',
      ...(c.area ? { area: true } : {}),
    }
  }

  // A place in a category that no longer exists draws a black dot in a layer
  // with no legend chip, which is a worse outcome than being told about it.
  const orphanCats = new Set()

  // Anchor lookup: normalised name -> POI. Used to place curated records.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const anchors = new Map()
  for (const p of byId.values()) {
    const k = norm(p.name)
    // Prefer named, pin-worthy features as anchors over generic footprints.
    if (!anchors.has(k) || categories[p.cat]?.pin) anchors.set(k, p)
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
  /**
   * An outline, if the row carries one: at least three [lon, lat] pairs, every
   * one inside the wall. A ring that wanders off campus is a survey mistake
   * worth naming rather than a shape worth drawing.
   */
  function outline(p) {
    if (!Array.isArray(p.poly) || p.poly.length < 3) {
      if (p.poly) warn(`curated "${p.id}" has an outline with fewer than 3 points`)
      return null
    }
    const pts = p.poly
      .filter((c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite))
      .map(([lon, lat]) => [+(+lon).toFixed(6), +(+lat).toFixed(6)])
    if (pts.length !== p.poly.length) { warn(`curated "${p.id}" has a malformed outline point`); return null }
    const stray = pts.filter(([lon, lat]) => !inArea(lon, lat)).length
    if (stray) warn(`curated "${p.id}" has ${stray} outline point(s) outside the survey area`)
    // Closed for GeoJSON's sake; the editor stores it open.
    const first = pts[0], last = pts[pts.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) pts.push([...first])
    return pts
  }

  for (let p of curated.places?.items ?? []) {
    const poly = outline(p)
    // An area drawn without a point still needs one, for search results and for
    // the panel to have somewhere to fly to.
    if (poly && (p.lat == null || p.lon == null)) {
      const [lon, lat] = centroid(poly.map(([x, y]) => ({ lon: x, lat: y })))
      p = { ...p, lat, lon }
    }
    if (poly) p = { ...p, poly }

    if (p.lat != null && p.lon != null) {
      if (!inArea(p.lon, p.lat)) { warn(`curated "${p.id}" is outside the survey area`); continue }
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

  for (const p of byId.values()) if (!categories[p.cat]) orphanCats.add(p.cat)
  for (const c of orphanCats) {
    const n = [...byId.values()].filter((p) => p.cat === c).length
    warn(`${n} place(s) are in category "${c}", which no longer exists — they will draw unstyled`)
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

  // No building layer. OpenStreetMap's footprints here were 38 squares against
  // a campus full of buildings, and over the photograph they sat visibly offset
  // from the roofs they claimed — a drawn approximation of something the
  // imagery already shows exactly. What a building is on this map is now the
  // outline somebody traced, which lives in places.json with the rest of the
  // survey. `buildings.json` stays in data/raw: the classifier still reads it
  // when `places.fromOsm` is on.

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
      area,
      attribution: '© OpenStreetMap contributors (ODbL)',
      osmWay: SITE.osm.campusWay,
      counts,
    },
    categories,
    groups: GROUPS,
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
  console.log(`geo        ${pathF.length} paths, ${roadF.length} roads, ${greenF.length} green (no OSM building layer)`)
  for (const k of Object.keys(curated)) {
    console.log(`curated    ${k}: ${curated[k]?.items?.length ?? 0} items`)
  }
  console.log(`categories ${Object.keys(categories).length}` + (catEdits.length
    ? ` (${catAdded} added, ${catRetuned} retuned, ${catRetired} retired by hand)`
    : ' (built-in set — none edited)'))
  console.log(`area       campus + ${RADIUS_KM} km: ${area[0][1]}–${area[1][1]} N, ${area[0][0]}–${area[1][0]} E`)
  console.log(`output     campus ${kb(campus)}, geo ${kb(geo)}`)
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`)
    for (const w of [...new Set(warnings)].slice(0, 25)) console.log(`  ! ${w}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
