import type { Campus, Poi } from '../types'
import { openNow } from './hours'

/* ── documents ───────────────────────────────────────────────────────────── */

export type Kind = 'place' | 'layer' | 'action' | 'hint'

export interface Doc {
  kind: Kind
  id: string
  title: string
  sub: string
  /** Everything matchable, lowercase, space-joined. Built once. */
  hay: string
  /** Tokens given prefix-match priority — the name words, codes, aliases. */
  keys: string[]
  cat?: string
  lat?: number
  lon?: number
  poi?: Poi
  hours?: string
  /** Nudges ties: higher wins. */
  boost: number
  run?: () => void
}

export interface Hit extends Doc {
  score: number
  /** Character indices in `title` that matched, for highlighting. */
  marks: number[]
}

const lower = (s: string) => s.toLowerCase()
const words = (s: string) => lower(s).split(/[^a-z0-9]+/).filter(Boolean)

/* ── scoring ─────────────────────────────────────────────────────────────── */

/**
 * Subsequence match with contiguity and word-boundary bonuses, in the spirit of
 * fzf but far simpler. Returns null for no match. Left-anchored matches and
 * matches that start a word score much higher, which is what makes "h9",
 * "downing", "cycl" and "central lib" all land where you expect.
 */
function fuzzy(needle: string, hay: string): { score: number; at: number[] } | null {
  if (!needle) return { score: 0, at: [] }
  const n = needle.length, h = hay.length
  if (n > h) return null

  const at: number[] = []
  let score = 0
  let hi = 0
  let streak = 0

  for (let ni = 0; ni < n; ni++) {
    const c = needle[ni]!
    let found = -1
    while (hi < h) {
      if (hay[hi] === c) { found = hi; break }
      hi++
    }
    if (found === -1) return null

    let bonus = 1
    const prev = found > 0 ? hay[found - 1]! : ' '
    if (found === 0) bonus += 8
    else if (prev === ' ' || prev === '-' || prev === '/') bonus += 6
    else if (prev >= '0' && prev <= '9' && !(c >= '0' && c <= '9')) bonus += 2

    streak = at.length && at[at.length - 1] === found - 1 ? streak + 1 : 0
    bonus += Math.min(streak * 3, 12)

    score += bonus
    at.push(found)
    hi = found + 1
  }

  // Prefer shorter haystacks and matches that start early.
  score -= Math.min(at[0]! * 0.4, 12)
  score -= Math.min(h * 0.02, 6)
  return { score, at }
}

function scoreDoc(doc: Doc, q: string, qWords: string[]): Hit | null {
  let best = -1
  let marks: number[] = []

  // 1. The whole title, typed out. Outranks everything else — otherwise a place
  //    whose name doubles as a category word ("Oval") loses to its own layer.
  //    A real place wins that tie outright: type "Staff Quarters" and you want
  //    the building, not the layer of the same name.
  if (lower(doc.title) === q) best = doc.kind === 'place' ? 1500 : 1400

  // 2. Exact / prefix on a key token — the strongest signal after that.
  for (const k of doc.keys) {
    if (k === q) { best = Math.max(best, 1000); break }
    if (k.startsWith(q)) best = Math.max(best, 700 - (k.length - q.length))
  }

  // 3. Title fuzzy.
  const t = fuzzy(q, lower(doc.title))
  if (t) {
    const s = 300 + t.score
    if (s > best) { best = s; marks = t.at }
  }

  // 4. Every query word must appear somewhere. Handles "hostel mess",
  //    "civil department", "cycle stand" — order-independent.
  if (best < 0 && qWords.length > 1) {
    let all = true
    let sum = 0
    for (const w of qWords) {
      const i = doc.hay.indexOf(w)
      if (i === -1) { all = false; break }
      sum += 40 - Math.min(i * 0.05, 20)
    }
    if (all) best = sum
  }

  // 5. Last resort: substring anywhere in the haystack.
  if (best < 0) {
    const i = doc.hay.indexOf(q)
    if (i === -1) return null
    best = 30 - Math.min(i * 0.05, 20)
  }

  return { ...doc, score: best + doc.boost, marks }
}

/* ── index ───────────────────────────────────────────────────────────────── */

export class SearchIndex {
  readonly docs: Doc[] = []
  private readonly campus: Campus

  constructor(campus: Campus, hooks: {
    onLayer: (cat: string) => void
    onAction: (id: string) => void
  }) {
    this.campus = campus

    for (const p of campus.pois) {
      const alias = ALIASES[p.cat] ?? []
      const keys = [...words(p.name), ...alias]

      // "Hostel 9" should be reachable as h9, hostel9, or just 9.
      const hostelNo = /\bHostel[\s-]?(\d+)\b/i.exec(p.name)
      if (hostelNo) keys.push(`h${hostelNo[1]}`, `hostel${hostelNo[1]}`, hostelNo[1]!)
      // "Lecture Hall 3" / "LT 3" -> l3, lh3.
      const lectureNo = /^(?:Lecture (?:Hall|Theatre)|LT)[\s-]?(\d+)$/i.exec(p.name)
      if (lectureNo) keys.push(`l${lectureNo[1]}`, `lh${lectureNo[1]}`, lectureNo[1]!)
      // Halls of residence are known by the surname alone — "Downing", "Slater".
      const named = /^(.+?)\s+Hall\b/i.exec(p.name)
      if (named) keys.push(lower(named[1]!))
      // Department buildings get their initials: "Civil Engineering" -> ce.
      const initials = words(p.name).filter((w) => w.length > 2).map((w) => w[0]).join('')
      if (initials.length >= 2 && initials.length <= 5) keys.push(initials)

      this.docs.push({
        kind: 'place',
        id: p.id,
        title: p.name,
        sub: [campus.categories[p.cat]?.label, p.near ? `near ${p.near}` : '', p.operator ?? '']
          .filter(Boolean).join(' · '),
        hay: lower([p.name, p.alt, p.cat, campus.categories[p.cat]?.label, p.kind, p.operator,
                    p.cuisine, p.desc, p.near, ...alias].filter(Boolean).join(' ')),
        keys,
        cat: p.cat,
        lat: p.lat, lon: p.lon,
        poi: p,
        hours: p.hours,
        boost: (p.unnamed ? -30 : 0) + (campus.categories[p.cat]?.pin ? 12 : 0),
      })
    }

    for (const [cat, meta] of Object.entries(campus.categories)) {
      const n = campus.meta.counts[cat] ?? 0
      if (!n) continue
      this.docs.push({
        kind: 'layer',
        id: `layer:${cat}`,
        title: meta.label,
        sub: `Show all ${n} on the map`,
        hay: lower([cat, meta.label, ...(ALIASES[cat] ?? [])].join(' ')),
        keys: [cat, ...words(meta.label), ...(ALIASES[cat] ?? [])],
        cat,
        boost: 8,
        run: () => hooks.onLayer(cat),
      })
    }

    for (const a of ACTIONS) {
      this.docs.push({
        kind: 'action',
        id: `do:${a.id}`,
        title: a.title,
        sub: a.sub,
        hay: lower([a.title, a.sub, a.words].join(' ')),
        keys: words(a.title + ' ' + a.words),
        boost: 2,
        run: () => hooks.onAction(a.id),
      })
    }
  }

  search(raw: string, limit = 40): Hit[] {
    const q = lower(raw.trim())
    if (!q) return []
    const qWords = words(q)

    const out: Hit[] = []
    for (const doc of this.docs) {
      const hit = scoreDoc(doc, q, qWords)
      if (hit) out.push(hit)
    }
    out.sort((a, b) => b.score - a.score || a.title.length - b.title.length)

    // "open now" nudge: among close scores, prefer somewhere you can actually go.
    const top = out.slice(0, limit)
    for (const h of top) {
      const st = openNow(h.hours)
      if (st?.open) h.score += 3
    }
    top.sort((a, b) => b.score - a.score)
    return top
  }

  /** Suggestions for the empty state — only categories this campus actually has. */
  examples(): string[] {
    const counts = this.campus.meta.counts
    // Category key -> the word to suggest for it. Only the ones this campus
    // actually has anything in are offered, so no suggestion comes back empty.
    const wanted: [string, string][] = [
      ['hostel', 'hostel'], ['academic', 'department'], ['library', 'library'],
      ['lake', 'lake'], ['sports', 'ground'], ['landmark', 'tower'],
      ['canteen', 'canteen'], ['mess', 'mess'], ['water', 'water'],
      ['activity', 'club'], ['health', 'hospital'], ['atm', 'atm'],
      ['cycle', 'cycle parking'],
    ]
    const out = wanted.filter(([cat]) => counts[cat]).map(([, word]) => word)
    // Nothing on the map: suggest the commands, which always exist.
    if (!out.length) {
      return import.meta.env.DEV
        ? ['tag mode', 'satellite', 'my tags', 'about']
        : ['satellite', 'about']
    }
    return out.slice(0, 6)
  }
}

/* ── vocabulary ──────────────────────────────────────────────────────────── */

/** Words a student would actually type for each category, English and Bangla. */
const ALIASES: Record<string, string[]> = {
  lecture: ['lecture', 'class', 'theatre', 'lt', 'lh', 'hall', 'room', 'tut', 'tutorial', 'auditorium'],
  academic: ['dept', 'department', 'lab', 'building', 'office', 'block', 'centre', 'center'],
  landmark: ['landmark', 'tower', 'monument', 'memorial', 'statue', 'gate', 'clock', 'spot'],
  lake: ['lake', 'pond', 'water', 'jheel', 'pukur', 'dighi', 'boating', 'jol'],
  activity: ['club', 'society', 'activity', 'activities', 'extracurricular', 'cultural',
             'gymkhana', 'union', 'ncc', 'nss', 'music', 'dance', 'drama', 'fest', 'hobby'],
  abandoned: ['abandoned', 'ruins', 'ruined', 'derelict', 'disused', 'empty', 'old', 'broken'],
  hostel: ['hostel', 'hall', 'residence', 'room', 'wing', 'block', 'nivas'],
  mess: ['mess', 'food', 'khabar', 'khana', 'meal', 'breakfast', 'lunch', 'dinner'],
  canteen: ['canteen', 'cafe', 'coffee', 'food', 'eat', 'restaurant', 'snack', 'cha', 'chai', 'tea', 'tiffin'],
  shop: ['shop', 'store', 'buy', 'grocery', 'market', 'stationery', 'dokan'],
  print: ['print', 'printer', 'printout', 'xerox', 'photocopy', 'copy', 'scan', 'binding'],
  water: ['water', 'cooler', 'drinking', 'ro', 'bottle', 'jol', 'pani'],
  atm: ['atm', 'cash', 'money', 'bank', 'withdraw', 'uco'],
  cycle: ['cycle', 'cycles', 'bike', 'bicycle', 'parking', 'stand', 'puncture', 'repair'],
  laundry: ['laundry', 'wash', 'washing', 'dhobi', 'clothes', 'iron', 'dryclean'],
  health: ['health', 'doctor', 'hospital', 'clinic', 'medical', 'pharmacy', 'medicine', 'emergency', 'counselling'],
  sports: ['sports', 'gym', 'ground', 'court', 'field', 'pool', 'swim', 'run', 'track', 'play', 'oval'],
  toilet: ['toilet', 'washroom', 'restroom', 'bathroom', 'loo'],
  vending: ['vending', 'machine', 'snack', 'chips'],
  worship: ['temple', 'mosque', 'church', 'prayer', 'worship', 'mandir'],
  transport: ['bus', 'parking', 'fuel', 'petrol', 'auto', 'taxi', 'charging', 'gate'],
  admin: ['office', 'admin', 'security', 'police', 'library', 'post', 'help', 'lost', 'found', 'guest'],
  green: ['park', 'garden', 'green', 'lawn', 'maath'],
}

interface Action { id: string; title: string; sub: string; words: string }

/**
 * The surveying commands. Kept in their own array so that the ternary below
 * folds to `[]` in a build and the whole thing tree-shakes out — a `dev` flag
 * filtered at runtime would leave all this wording in the bundle, describing a
 * feature the published site does not have.
 */
const DEV_ACTIONS: Action[] = [
  { id: 'tag-mode', title: 'Tag mode', sub: 'Tap the map to add a missing place', words: 'tag add missing new mark edit survey contribute' },
  { id: 'tags', title: 'My tags', sub: 'Export or delete the places you tagged', words: 'tags mine saved export json download list' },
  { id: 'tags-clear', title: 'Delete all my tags', sub: 'Clears every tag in this browser', words: 'delete remove clear wipe reset all tags' },
]

const ACTIONS: Action[] = [
  // "google" and "google maps" are in here on purpose: it is what people type
  // when they mean "show me the actual photo of this place".
  { id: 'imagery', title: 'Satellite imagery', sub: 'Aerial photo under the map', words: 'satellite aerial imagery photo google maps earth view real' },
  { id: 'layers-all', title: 'Show every layer', sub: 'Turn all categories on', words: 'all layers everything show' },
  { id: 'layers-none', title: 'Hide every layer', sub: 'Clear the map', words: 'none clear hide reset layers' },
  ...(import.meta.env.DEV ? DEV_ACTIONS : []),
]
