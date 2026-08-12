import type { Hit, SearchIndex, Kind } from '../search/engine'
import { openNow } from '../search/hours'
import type { Campus } from '../types'

const root = document.getElementById('palette') as HTMLElement
const input = document.getElementById('palette-input') as HTMLInputElement
const list = document.getElementById('palette-results') as HTMLElement
const timing = document.getElementById('palette-timing') as HTMLElement
const count = document.getElementById('palette-count') as HTMLElement

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const GROUP: Record<Kind, string> = {
  place: 'Places', layer: 'Layers', action: 'Commands', hint: '',
}
const ORDER: Kind[] = ['place', 'layer', 'action']

export interface PaletteHost {
  index: SearchIndex
  campus: Campus
  open(hit: Hit): void
}

let host: PaletteHost
let hits: Hit[] = []
let cursor = 0

export function initPalette(h: PaletteHost) {
  host = h

  input.addEventListener('input', () => render(input.value))
  input.addEventListener('keydown', onKey)

  root.addEventListener('mousedown', (e) => {
    // Tapping the backdrop closes. Inside the box, swallow the default so a
    // click on a result does not blur the input — but never for the input
    // itself or a real control, or a tap can no longer refocus it and the
    // on-screen keyboard will not come back.
    const t = e.target as HTMLElement
    if (t === root) { closePalette(); return }
    if (t === input || t.closest('button, a, input')) return
    e.preventDefault()
  })

  // Full-screen on a phone means no backdrop to tap and no Escape key, so the
  // palette needs a way out that does not depend on either.
  document.getElementById('palette-close')!.addEventListener('click', closePalette)

  list.addEventListener('click', (e) => {
    const c = (e.target as HTMLElement).closest('code[data-try]') as HTMLElement | null
    if (c) {
      input.value = c.dataset.try!
      render(input.value)
      input.focus()
      return
    }
    const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null
    if (!row) return
    cursor = +row.dataset.i!
    commit()
  })

  list.addEventListener('mousemove', (e) => {
    const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null
    if (!row || +row.dataset.i! === cursor) return
    cursor = +row.dataset.i!
    paintCursor()
  })

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement)?.tagName)
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
      e.preventDefault()
      openPalette()
    }
  })

  document.getElementById('open-search')!.addEventListener('click', () => openPalette())
}

export function openPalette(prefill = '') {
  root.hidden = false
  if (prefill) input.value = prefill
  input.focus()
  input.select()
  render(input.value)
}

export function closePalette() {
  root.hidden = true
  input.blur()
}

function onKey(e: KeyboardEvent) {
  switch (e.key) {
    case 'Escape': e.preventDefault(); closePalette(); break
    case 'ArrowDown': e.preventDefault(); move(1); break
    case 'ArrowUp': e.preventDefault(); move(-1); break
    case 'Home': if (hits.length) { e.preventDefault(); cursor = 0; paintCursor() } break
    case 'End': if (hits.length) { e.preventDefault(); cursor = hits.length - 1; paintCursor() } break
    case 'Enter': e.preventDefault(); commit(); break
    case 'n': if (e.ctrlKey) { e.preventDefault(); move(1) } break
    case 'p': if (e.ctrlKey) { e.preventDefault(); move(-1) } break
  }
}

function move(d: number) {
  if (!hits.length) return
  cursor = (cursor + d + hits.length) % hits.length
  paintCursor()
}

function commit() {
  const hit = hits[cursor]
  if (!hit) return
  host.open(hit)
  if (hit.kind !== 'layer') closePalette()
}

/* ── render ──────────────────────────────────────────────────────────────── */

function render(raw: string) {
  const t0 = performance.now()
  const q = raw.trim()
  hits = q ? host.index.search(q) : []
  const ms = performance.now() - t0

  cursor = 0
  timing.textContent = q ? `${ms < 1 ? ms.toFixed(2) : ms.toFixed(1)}ms` : ''
  count.textContent = q ? `${hits.length}` : `${host.index.docs.length} indexed`

  if (!q) { list.innerHTML = welcome(); return }
  if (!hits.length) { list.innerHTML = empty(q); return }

  const seen = new Set<Kind>()
  const parts: string[] = []
  // Keep the ranked order, but label the first row of each kind as it appears.
  const grouped = [...hits].sort((a, b) => {
    const ga = ORDER.indexOf(a.kind), gb = ORDER.indexOf(b.kind)
    return ga - gb || b.score - a.score
  })
  hits = grouped

  grouped.forEach((h, i) => {
    if (!seen.has(h.kind)) { seen.add(h.kind); parts.push(`<div class="grp">${GROUP[h.kind]}</div>`) }
    parts.push(row(h, i))
  })
  list.innerHTML = parts.join('')
  paintCursor()
}

function row(h: Hit, i: number) {
  const colour = h.cat ? host.campus.categories[h.cat]?.color ?? '#6b7482' : '#6b7482'

  let meta = ''
  const st = openNow(h.hours)
  if (st?.open) meta = `<span class="open">open${st.until ? ` · ${st.until}` : ''}</span>`
  else if (st && !st.open) meta = `<span class="shut">closed</span>`
  else if (h.kind === 'action') meta = '↵'
  else if (h.kind === 'layer') meta = 'layer'

  return `<div class="row" role="option" data-i="${i}" aria-selected="false">
    <span class="row-dot" style="background:${colour}"></span>
    <span class="row-main">
      <span class="row-title">${mark(h.title, h.marks)}</span>
      ${h.sub ? `<span class="row-sub">${esc(h.sub)}</span>` : ''}
    </span>
    ${meta ? `<span class="row-meta">${meta}</span>` : ''}
  </div>`
}

function mark(title: string, at: number[]) {
  if (!at.length) return esc(title)
  const set = new Set(at)
  let out = ''
  let open = false
  for (let i = 0; i < title.length; i++) {
    const hit = set.has(i)
    if (hit && !open) { out += '<mark>'; open = true }
    if (!hit && open) { out += '</mark>'; open = false }
    out += esc(title[i])
  }
  return out + (open ? '</mark>' : '')
}

function paintCursor() {
  const rows = list.querySelectorAll<HTMLElement>('.row')
  rows.forEach((r) => r.setAttribute('aria-selected', String(+r.dataset.i! === cursor)))
  rows[cursor]?.scrollIntoView({ block: 'nearest' })
}

function welcome() {
  const ex = host.index.examples()
  return `<div class="empty">
    <b>Every mapped place on campus</b>
    ${ex.map((e) => `<code data-try="${esc(e)}">${esc(e)}</code>`).join('')}
  </div>`
}

function empty(q: string) {
  // Be specific about the known gaps rather than shrugging.
  const missing =
    /^[a-z]{2,4}\s?\d{3}$/i.test(q) ? 'Course data is not loaded — there is no public timetable API.'
    : /\bclub\b|\bsociety\b|\bfest\b/i.test(q) ? 'Clubs and fests are not loaded — no machine-readable source.'
    : /\bprof|faculty|teacher|sir\b/i.test(q) ? 'Faculty are not indexed here — this map is places only.'
    : /\bmenu\b|\btoday.*food\b/i.test(q) ? 'Mess menus are not loaded — no public feed for them.'
    : /\bbus\b|airport|station|train|howrah/i.test(q) ? 'Bus and train timings are not loaded.'
    : /notice|deadline|exam/i.test(q) ? 'Notices are not loaded — no public feed found.'
    : 'Not everything on campus is in OpenStreetMap yet. If you know where it is, map it there and it lands here on the next build.'

  return `<div class="empty">
    <b>No match for “${esc(q)}”</b>
    <div class="why">${esc(missing)}</div>
    ${host.index.examples().slice(0, 4).map((e) => `<code data-try="${esc(e)}">${esc(e)}</code>`).join('')}
  </div>`
}
