import type { Campus, Poi } from '../types'
import { panelShell } from './panel'

/**
 * Tag places the map does not know about yet.
 *
 * OpenStreetMap's coverage of this campus is thin — most academic blocks are
 * unnamed footprints and the footpath network barely exists. Tagging here is
 * the fast path: mark it now, keep using the map, and export the lot as a
 * `data/curated/places.json` fragment when you are ready to commit it. Every
 * form also links straight into the OSM editor, which is where a real place
 * ultimately belongs — map it there and every other map gets it too.
 *
 * Tags live in this browser's localStorage and nowhere else. There is no
 * server; nothing is uploaded.
 */

const KEY = 'campusmap.tags.v1'

export interface Tag {
  id: string
  name: string
  cat: string
  lat: number
  lon: number
  desc?: string
  /** Outline as [lon, lat] pairs, open (the build closes it). */
  poly?: [number, number][]
  /** Overrides the category colour. How one building is told from the next. */
  color?: string
  /** ISO date the tag was made, so an export says how old its rows are. */
  on: string
}

/**
 * The tints a building can take. Buildings all share one category, so the
 * category colour cannot tell them apart — this is the scheme to pick from
 * instead. Muted on purpose: these are drawn at a fifth opacity over a
 * photograph, and a saturated fill buries the roof underneath it.
 */
export const TINTS: [string, string][] = [
  ['#9aa7b8', 'Slate'],
  ['#7fa8d9', 'Blue'],
  ['#8fc9c4', 'Teal'],
  ['#8fbf7f', 'Green'],
  ['#c9bd7f', 'Khaki'],
  ['#e0a458', 'Sand'],
  ['#d98f8f', 'Clay'],
  ['#c58fbf', 'Mauve'],
]

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

let tags: Tag[] = read()
const listeners = new Set<() => void>()

function read(): Tag[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    // Anything that lost a field — a hand-edited store, an older shape — is
    // dropped rather than allowed to render as a pin with no position.
    return Array.isArray(raw)
      ? raw.filter((t) => t && t.id && t.name && t.cat &&
                          Number.isFinite(t.lat) && Number.isFinite(t.lon))
      : []
  } catch {
    return []
  }
}

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(tags))
  } catch {
    // Private browsing, or a full quota. The tags stay live in memory for this
    // session; saying so beats failing silently.
    alert('Could not save to this browser’s storage — your tags will be lost when you close the tab. Export them now.')
  }
  for (const fn of listeners) fn()
}

export function allTags(): Tag[] { return tags }
export function tagCount(): number { return tags.length }
export function onTagsChange(fn: () => void) { listeners.add(fn) }

/** Tags as POIs, so the map and the search index can treat them like any other. */
export function tagPois(): Poi[] {
  return tags.map((t) => ({
    id: t.id,
    name: t.name,
    cat: t.cat,
    lat: t.lat,
    lon: t.lon,
    src: 'seed' as const,
    desc: t.desc,
    user: true as const,
    ...(t.poly?.length ? { poly: t.poly } : {}),
    ...(t.color ? { color: t.color } : {}),
  }))
}

export function getTag(id: string): Tag | undefined {
  return tags.find((t) => t.id === id)
}

/**
 * Move a place's marker, leaving its outline alone.
 *
 * The two are independent: an outline says what a place occupies, the marker
 * says where to put its dot — the door, the counter, the end of the jetty — and
 * the middle of a shape is rarely any of those.
 */
export function movePoint(id: string, lon: number, lat: number) {
  tags = tags.map((t) => (t.id === id ? { ...t, lat: +lat.toFixed(6), lon: +lon.toFixed(6) } : t))
  write()
}

/** The map owns tapping, so it registers what to do when the form asks. */
let requestMove: ((id: string) => void) | null = null
export function onRequestMovePoint(fn: (id: string) => void) { requestMove = fn }

export function deleteTag(id: string) {
  tags = tags.filter((t) => t.id !== id)
  write()
}

/** Wipe the lot. Confirms first — this is the one action here that loses work. */
export function clearAllTags(): boolean {
  if (!tags.length) { showTagList(); return false }
  if (!confirm(`Delete all ${tags.length} tags from this browser? Export them first if you want to keep them.`)) {
    return false
  }
  tags = []
  write()
  showTagList()
  return true
}

function slug(name: string) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return `${s || 'place'}-${Date.now().toString(36).slice(-4)}`
}

/** The exact shape `data/curated/places.json` expects, ready to paste in. */
export function exportJson(): string {
  return JSON.stringify({
    _source: 'survey',
    _note: 'Exported from the map’s tag mode. Check each row against reality before committing it.',
    items: tags.map(({ on, ...rest }) => ({ ...rest, surveyed: on })),
  }, null, 2)
}

/* ── UI ──────────────────────────────────────────────────────────────────── */

let campus: Campus
let onDone: (() => void) | null = null

export function initTagger(c: Campus) {
  campus = c

  const panel = document.getElementById('panel')!
  panel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement

    if (t.closest('[data-tag-save]')) { save(); return }
    if (t.closest('[data-tag-cancel]')) { hide(); return }
    if (t.closest('[data-tag-list]')) { showTagList(); return }
    if (t.closest('[data-tag-export]')) { download(); return }
    if (t.closest('[data-tag-copy]')) { copy(t.closest('[data-tag-copy]') as HTMLElement); return }
    if (t.closest('[data-tag-clear]')) { clearAllTags(); return }
    const move = t.closest('[data-tag-move]') as HTMLElement | null
    if (move) { requestMove?.(move.dataset.tagMove!); return }
    const edit = t.closest('[data-tag-edit]') as HTMLElement | null
    if (edit) { showEditForm(edit.dataset.tagEdit!); return }
    const del = t.closest('[data-tag-del]') as HTMLElement | null
    if (del) { deleteTag(del.dataset.tagDel!); showTagList(); return }
  })

  // Enter submits, so tagging a row of cycle stands does not mean reaching for
  // the mouse every time.
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).id === 'tag-name') {
      e.preventDefault()
      save()
    }
  })
}

interface Pending {
  /** Set when editing something that already exists rather than creating. */
  id?: string
  lat: number
  lon: number
  poly?: [number, number][]
  near?: string
}
let pending: Pending | null = null

function form(title: string, kind: string, t: Partial<Tag>, near?: string) {
  const cat = t.cat ?? (t.poly ? 'building' : 'academic')
  const options = Object.entries(campus.categories)
    .map(([k, v]) => `<option value="${k}"${k === cat ? ' selected' : ''}>${esc(v.label)}</option>`)
    .join('')
  const chosen = t.color ?? TINTS[0]![0]
  const swatches = TINTS.map(([hex, label]) =>
    `<button type="button" class="swatch${hex === chosen ? ' on' : ''}" data-tint="${hex}"
             style="background:${hex}" title="${esc(label)}" aria-label="${esc(label)}"></button>`).join('')

  panelShell(title, kind, `
    <div class="tag-form">
      <label for="tag-name">Name</label>
      <input id="tag-name" type="text" autocomplete="off" spellcheck="false"
             placeholder="e.g. Civil Engineering Dept" value="${esc(t.name ?? near ?? '')}">

      <label for="tag-cat">What is it</label>
      <select id="tag-cat">${options}</select>

      <div id="tag-tint-row" hidden>
        <label>Colour</label>
        <div class="swatches" id="tag-tints">${swatches}</div>
      </div>

      <label for="tag-desc">Note <span class="opt">optional</span></label>
      <input id="tag-desc" type="text" autocomplete="off"
             placeholder="why a student cares" value="${esc(t.desc ?? '')}">

      <div class="p-actions">
        <button data-tag-save class="primary">${t.id ? 'Save changes' : 'Save tag'}</button>
        <button data-tag-cancel>Cancel</button>
      </div>
      ${t.id ? `<div class="p-actions">
        <button data-tag-move="${esc(t.id)}">Move marker</button>
        <button data-tag-del="${esc(t.id)}" class="danger">Delete this place</button>
      </div>` : ''}
    </div>

    <p class="p-note">${t.poly?.length ? `An outline of <b>${t.poly.length}</b> points. ` : ''}Saved
    in this browser only — nothing is uploaded. Export the set from <b>My tags</b>
    in search when you want to commit it to
    <code>data/curated/places.json</code>.</p>`)

  // Every building shares one category, so the category colour cannot tell one
  // from the next — the tint does. It means nothing for anything else, so it
  // only appears for a building.
  const sel = document.getElementById('tag-cat') as HTMLSelectElement
  const row = document.getElementById('tag-tint-row') as HTMLElement
  const syncTint = () => { row.hidden = sel.value !== 'building' }
  sel.addEventListener('change', syncTint)
  syncTint()

  document.getElementById('tag-tints')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-tint]') as HTMLElement | null
    if (!b) return
    document.querySelectorAll('#tag-tints .swatch').forEach((x) => x.classList.remove('on'))
    b.classList.add('on')
  })

  const name = document.getElementById('tag-name') as HTMLInputElement | null
  name?.focus()
  name?.select()
}

/** Open the form for a new place. `poly` makes it an area; `near` prefills. */
export function showTagForm(
  lat: number, lon: number, near?: string, done?: () => void,
  poly?: [number, number][],
) {
  pending = { lat, lon, near, ...(poly ? { poly } : {}) }
  onDone = done ?? null
  form(poly ? 'Tag this area' : 'Tag this place',
       poly ? `outline · ${poly.length} points` : `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
       poly ? { poly } : {}, near)
}

/** Open the form for something already tagged, to change or delete it. */
export function showEditForm(id: string, done?: () => void) {
  const t = tags.find((x) => x.id === id)
  if (!t) return
  pending = { id: t.id, lat: t.lat, lon: t.lon, ...(t.poly ? { poly: t.poly } : {}) }
  onDone = done ?? null
  form('Edit place', t.poly?.length ? `outline · ${t.poly.length} points` : 'point', t)
}

function save() {
  if (!pending) return
  const name = (document.getElementById('tag-name') as HTMLInputElement).value.trim()
  const cat = (document.getElementById('tag-cat') as HTMLSelectElement).value
  const desc = (document.getElementById('tag-desc') as HTMLInputElement).value.trim()
  const tint = (document.querySelector('#tag-tints .swatch.on') as HTMLElement | null)?.dataset.tint

  if (!name) {
    const el = document.getElementById('tag-name') as HTMLInputElement
    el.focus()
    el.classList.add('bad')
    return
  }

  const existing = pending.id ? tags.find((t) => t.id === pending!.id) : undefined
  const next: Tag = {
    id: pending.id ?? slug(name),
    name,
    cat,
    lat: +pending.lat.toFixed(6),
    lon: +pending.lon.toFixed(6),
    ...(pending.poly?.length ? { poly: pending.poly } : {}),
    ...(cat === 'building' && tint ? { color: tint } : {}),
    ...(desc ? { desc } : {}),
    // Keep the original survey date when editing: it says when the ground was
    // seen, not when the typo was fixed.
    on: existing?.on ?? new Date().toISOString().slice(0, 10),
  }

  tags = pending.id ? tags.map((t) => (t.id === pending!.id ? next : t)) : [...tags, next]
  pending = null
  write()
  showTagList()
  onDone?.()
}

function hide() {
  pending = null
  document.getElementById('panel')!.hidden = true
  onDone?.()
}

export function showTagList() {
  const rows = tags.length
    ? tags.map((t) => `
        <div class="tag-row">
          <span class="dot" style="background:${t.color ?? campus.categories[t.cat]?.color ?? '#8b949e'}"></span>
          <span class="tag-main">
            <b>${esc(t.name)}</b>
            <em>${esc(campus.categories[t.cat]?.label ?? t.cat)}${t.poly?.length ? ' · area' : ''} · ${esc(t.on)}</em>
          </span>
          <button class="linkish" data-tag-edit="${esc(t.id)}" aria-label="Edit ${esc(t.name)}">edit</button>
          <button data-tag-del="${esc(t.id)}" aria-label="Delete ${esc(t.name)}">&times;</button>
        </div>`).join('')
    : `<p class="p-note">No tags yet. Turn on tag mode in the top bar, then tap
       anywhere on the map.</p>`

  panelShell('My tags', `${tags.length} in this browser`, `
    ${rows}
    ${tags.length ? `<div class="p-actions" style="margin-top:14px">
      <button data-tag-export>Download JSON</button>
      <button data-tag-copy>Copy</button>
    </div>
    <p class="p-note">Paste the <code>items</code> array into
    <code>data/curated/places.json</code> and rebuild, and these become part of
    the map for everyone — with the build checking each one falls inside the
    campus boundary.</p>
    <div class="p-actions"><button data-tag-clear class="danger">Delete all ${tags.length} tags</button></div>` : ''}`)
}

function download() {
  const blob = new Blob([exportJson()], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'places.json'
  a.click()
  URL.revokeObjectURL(a.href)
}

async function copy(btn: HTMLElement) {
  try {
    await navigator.clipboard.writeText(exportJson())
    btn.textContent = 'Copied'
    setTimeout(() => { btn.textContent = 'Copy' }, 1400)
  } catch {
    btn.textContent = 'Copy failed'
  }
}
