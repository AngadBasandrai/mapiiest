// Solves the category palette. Not part of the build — run it when the category
// set changes, then paste the result into CATEGORIES in scripts/build-data.mjs.
//
//   node scripts/solve-palette.mjs
//
// The problem: N categories drawn as coloured dots on one dark ground. Picking
// N colours by eye stops working somewhere around eight; the previous
// hand-picked set had two categories on the same hex and nobody noticed by
// looking at the map.
//
// So: spread them as far apart as N colours can be — maximin on OKLab ΔE — and
// only then hand each category a colour, matching the hue and saturation it
// wants where the spread allows it. Separation is a property of the set, so the
// assignment step cannot spend any of it.
//
// This used to score the worse of two themes, because the app derived a light
// palette by scaling every channel by 0.62 and both had to work. The light
// theme is gone, and dropping that term is worth measuring rather than
// assuming: the ceiling moves from ΔE 11.0 to 11.2. Almost nothing — dimming
// by 0.62 compresses OKLab distances by about the same factor as the 12/8.5
// ratio the two floors were set at, so the light term was very nearly free.
//
// Which is why the shipped palette was NOT re-solved when the theme went. It
// already sits at 11.0, within 0.2 of what this can now reach, and rewriting
// all 39 hexes to buy that would be churn for its own sake. Re-solve when the
// category set changes, not when the ground does.
//
// `building` does not take part. It draws no dot: it is a fill at a fifth
// opacity that each building then overrides with its own tint from TINTS, so it
// wants a muted khaki that sits under a photograph rather than a colour that
// competes with 39 dots. It is pinned to the value that already works and held
// in the set as a fixed member, so the solver spreads the dots *around* it
// instead of the two being reconciled afterwards.

/* ── colour ─────────────────────────────────────────────────────────────── */

const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lin2s = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function oklab(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => s2lin(parseInt(hex.slice(1 + i, 3 + i), 16) / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s]
}

/** OKLCh -> #rrggbb, or null if the colour falls outside sRGB. */
function toHex(L, C, H) {
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  const rgb = [
    +4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
  ].map(lin2s)
  // Anything the monitor cannot show would be clipped, and a clipped colour is
  // no longer the one that was solved for — so reject rather than clamp.
  if (rgb.some((c) => c < -0.001 || c > 1.001)) return null
  return '#' + rgb.map((c) =>
    Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')
}

const dE = (x, y) => {
  const a = oklab(x), b = oklab(y)
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

const cost = dE

/* ── candidates ─────────────────────────────────────────────────────────── */

// A dot below ~0.55 disappears into the dark ground. The ceiling used to be
// 0.90, because above that the dimmed light-theme twin vanished into paper —
// with no light theme the top of the range is usable again, and near-white at
// low chroma is a genuinely distinct mark against #0b0d10. Chroma below 0.07
// reads as grey, which is what "no category" looks like.
const CAND = []
for (let L = 0.56; L <= 0.96001; L += 0.02) {
  for (let C = 0.07; C <= 0.32001; C += 0.01) {
    for (let H = 0; H < 360; H += 1.5) {
      const h = toHex(L, C, H)
      if (h) CAND.push({ hex: h, L, C, H })
    }
  }
}

/* ── maximin ────────────────────────────────────────────────────────────── */

/** The smallest pairwise cost in a set — the number being maximised. */
function worst(set) {
  let min = Infinity, pair = [0, 0]
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      const d = cost(set[i].hex, set[j].hex)
      if (d < min) { min = d; pair = [i, j] }
    }
  }
  return { min, pair }
}

/** Cost of the nearest member of `set` to `c`, ignoring index `skip`. */
function nearest(c, set, skip = -1) {
  let min = Infinity
  for (let i = 0; i < set.length; i++) {
    if (i === skip) continue
    const d = cost(c.hex, set[i].hex)
    if (d < min) min = d
  }
  return min
}

/**
 * Farthest-point greedy, then swap the member of the worst pair until stuck.
 *
 * `fixed` members are in the set from the start and are never swapped out, so
 * everything else is spread around them rather than against them.
 */
function solve(n, fixed = []) {
  const set = [...fixed]
  // Seed from the farthest pair in a sparse sample of the candidate cloud, so
  // the greedy pass does not start somewhere arbitrary and spiral in.
  if (!set.length) {
    let seed = null, seedD = -1
    for (let i = 0; i < CAND.length; i += 37) {
      for (let j = i + 1; j < CAND.length; j += 41) {
        const d = cost(CAND[i].hex, CAND[j].hex)
        if (d > seedD) { seedD = d; seed = [CAND[i], CAND[j]] }
      }
    }
    set.push(...seed)
  }

  while (set.length < n) {
    let best = null, bestD = -1
    for (const c of CAND) {
      const d = nearest(c, set)
      if (d > bestD) { bestD = d; best = c }
    }
    set.push(best)
  }

  for (let round = 0; round < 500; round++) {
    const { min, pair } = worst(set)
    let improved = false
    // Either member of the closest pair is a candidate for replacement; try
    // both, since which one is "at fault" is not knowable locally.
    for (const idx of pair) {
      if (idx < fixed.length) continue
      let best = null, bestD = min
      for (const c of CAND) {
        const d = nearest(c, set, idx)
        if (d > bestD + 1e-9) { bestD = d; best = c }
      }
      if (best) { set[idx] = best; improved = true; break }
    }
    if (!improved) { console.log(`  settled after ${round} swaps`); break }
  }
  return set
}

/* ── the category set ───────────────────────────────────────────────────── */

// `hue` is what the category would like if the spread can afford it: lakes
// blue, parks green, health red, quarters brown, food warm. `want` is how much
// it minds — 3 for a category whose colour is half its meaning, 1 for one that
// only needs to be distinct. The warm end is oversubscribed, so somebody has to
// give; the weights say who.
//
// `tone` is the other half of the ask, and hue alone got it wrong: a pale peach
// and a bright red are both "hue 25", but only one of them says hospital. '+'
// wants saturation, '-' wants to stay out of the way, '' has no view.
const CATS = [
  // campus
  ['academic',   'Depts & labs',          250, 2, ''],
  ['lecture',    'Lecture halls',          60, 1, ''],
  ['library',    'Libraries',              45, 1, ''],
  ['admin',      'Admin & help',          215, 1, ''],
  ['activity',   'Clubs & activities',    355, 1, '+'],
  ['hostel',     'Halls & hostels',       300, 2, ''],
  ['quarters',   'Staff quarters',         70, 2, '-'],
  ['mess',       'Messes',                140, 1, '+'],
  ['canteen',    'Canteens',              165, 1, ''],
  ['sports',     'Sports',                125, 2, ''],
  ['worship',    'Worship',               315, 2, '+'],
  ['landmark',   'Landmarks',              85, 1, '-'],
  ['lake',       'Lakes & ponds',         230, 3, '+'],
  ['green',      'Parks & gardens',       145, 3, '+'],
  ['abandoned',  'Abandoned',             285, 1, '-'],
  ['cycle',      'Cycle parking',         150, 1, ''],
  ['laundry',    'Laundry',               195, 1, ''],
  ['atm',        'ATMs & banks',           95, 2, '+'],
  ['health',     'Health',                 10, 3, '+'],
  ['shop',       'Shops',                 275, 1, ''],
  // food & drink — the whole group wants the warm end, and cannot all have it
  ['food',       'Restaurants & dhabas',   35, 3, '+'],
  ['street',     'Street food & rolls',    15, 2, '+'],
  ['tea',        'Tea stalls & cafes',     50, 3, '+'],
  ['sweets',     'Sweets & bakeries',      40, 2, '-'],
  // shops & services
  ['grocery',    'Grocery & kirana',      110, 1, ''],
  ['stationery', 'Stationery & xerox',    330, 1, ''],
  ['pharmacy',   'Pharmacies',            150, 2, ''],
  ['repair',     'Repairs & spares',      200, 1, ''],
  ['salon',      'Salons & barbers',      320, 1, ''],
  ['clothes',    'Clothes & tailors',     340, 1, ''],
  ['market',     'Markets & bazaars',      75, 1, '-'],
  // getting around
  ['transit',    'Buses, autos & totos',  190, 2, ''],
  ['ghat',       'Ferry ghats',           210, 2, ''],
  ['fuel',       'Petrol pumps',          260, 1, ''],
  ['gate',       'Gates',                 105, 1, ''],
  // off campus
  ['pg',         'PG & rentals',          305, 1, ''],
  ['locality',   'Localities & paras',    265, 1, '-'],
  ['school',     'Schools & coaching',    240, 1, ''],
  ['hangout',    'Hangouts & adda',       350, 1, '-'],
]

// Pinned, not solved — see the header. This is the value the 26-colour set
// arrived at and it is already known to read as a roof tint under imagery.
const BUILDING = { hex: '#adb78c', L: 0.74, C: 0.05, H: 121 }

const N = CATS.length
console.log(`solving ${N} dot colours around a fixed building tint, from ${CAND.length} candidates…`)
const solved = solve(N + 1, [BUILDING])
const set = solved.slice(1)

/* ── assignment ─────────────────────────────────────────────────────────── */

// Which colour goes to which category is a linear assignment problem, so solve
// it as one. Greedy gets this wrong in a way that matters: it hands the last
// few categories whatever nobody else claimed, which is how "restaurants" ends
// up green while some category that never cared holds an orange.
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }

/** Hungarian algorithm (Jonker-Volgenant form), square cost matrix. */
function assign(cost) {
  const n = cost.length
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1)
  const p = new Int32Array(n + 1), way = new Int32Array(n + 1)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Float64Array(n + 1).fill(Infinity)
    const used = new Uint8Array(n + 1)
    do {
      used[j0] = 1
      const i0 = p[j0]
      let delta = Infinity, j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0 }
        if (minv[j] < delta) { delta = minv[j]; j1 = j }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta }
        else minv[j] -= delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1 } while (j0)
  }
  const out = new Array(n)
  for (let j = 1; j <= n; j++) out[p[j] - 1] = j - 1
  return out
}

// Scaled so a full miss on tone costs about as much as a 40° miss on hue —
// enough to break a tie between two colours of the same hue, not enough to
// drag a category off the hue it actually needs.
const tonePenalty = (tone, C) =>
  tone === '+' ? 400 * Math.max(0, 0.17 - C)
  : tone === '-' ? 400 * Math.max(0, C - 0.12)
  : 0

const matrix = CATS.map(([, , hue, want, tone]) =>
  set.map((c) => want * hueGap(c.H, hue) + tonePenalty(tone, c.C)))
const picked = assign(matrix)
const out = new Map(CATS.map((c, i) => [c[0], set[picked[i]]]))

/* ── report ─────────────────────────────────────────────────────────────── */

const all = [['building', 'Buildings', BUILDING], ...CATS.map((c) => [c[0], c[1], out.get(c[0])])]
const pad = Math.max(...all.map((r) => r[0].length))
console.log('\n// paste into CATEGORIES in scripts/build-data.mjs\n')
for (const [key, label, c] of all) {
  console.log(`  ${(key + ':').padEnd(pad + 1)} '${c.hex}',  // ${label} — L${c.L.toFixed(2)} C${c.C.toFixed(2)} H${Math.round(c.H)}`)
}

const report = (list, name) => {
  let min = Infinity, pair = ''
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = dE(list[i][2].hex, list[j][2].hex)
      if (d < min) { min = d; pair = `${list[i][0]}/${list[j][0]}` }
    }
  }
  console.log(`  ${name}  ΔE ${min.toFixed(1)}  (${pair})`)
}
console.log('\nseparation')
report(all.filter((r) => r[0] !== 'building'), 'dots only    ')
report(all, 'with building')
