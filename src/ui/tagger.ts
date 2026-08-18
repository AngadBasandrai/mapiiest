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
  /**
   * A tombstone for a committed place. Deleting something that shipped in
   * places.json cannot remove it from the file, so it is recorded as retired
   * here and left out of the map and the export.
   */
  deleted?: true
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

/**
 * The places the build shipped, which local records edit on top of.
 *
 * Everything in data/curated/places.json is already on the map when you arrive,
 * so "edit a tag" mostly means editing one of those — not one you made this
 * session. A local record with the same id overrides it; the export writes the
 * merged result, so a round trip through the editor reproduces the whole file.
 */
let base: Poi[] = []
const isBase = (id: string) => base.some((p) => p.id === id)

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
/** How many committed places you have changed, plus how many you have added. */
export function tagCount(): number { return tags.length }
export function onTagsChange(fn: () => void) { listeners.add(fn) }

function toPoi(t: Tag): Poi {
  return {
    id: t.id,
    name: t.name,
    cat: t.cat,
    lat: t.lat,
    lon: t.lon,
    src: 'seed' as const,
    ...(t.desc ? { desc: t.desc } : {}),
    user: true as const,
    ...(t.poly?.length ? { poly: t.poly } : {}),
    ...(t.color ? { color: t.color } : {}),
  }
}

/**
 * The shipped places with local edits applied: overrides replace, tombstones
 * remove, and anything new is appended.
 */
export function applyEdits(basePois: Poi[]): Poi[] {
  const pending = new Map(tags.map((t) => [t.id, t]))
  const out: Poi[] = []
  for (const p of basePois) {
    const t = pending.get(p.id)
    if (!t) { out.push(p); continue }
    pending.delete(p.id)
    if (t.deleted) continue
    // Spread over the original so fields the editor does not touch survive.
    out.push({ ...p, ...toPoi(t) })
  }
  for (const t of pending.values()) if (!t.deleted) out.push(toPoi(t))
  return out
}

/** Everything currently on the map, shipped or local. */
export function allPlaces(): Poi[] { return applyEdits(base) }

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
  if (isBase(id)) {
    // It lives in the committed file, so it can only be retired here — and the
    // export leaves it out, which is what actually removes it.
    const gone = base.find((p) => p.id === id)!
    tags = [...tags.filter((t) => t.id !== id), {
      id, name: gone.name, cat: gone.cat, lat: gone.lat, lon: gone.lon,
      on: new Date().toISOString().slice(0, 10), deleted: true,
    }]
  } else {
    tags = tags.filter((t) => t.id !== id)
  }
  write()
}

/** Put a retired or edited committed place back the way it shipped. */
export function revertTag(id: string) {
  tags = tags.filter((t) => t.id !== id)
  write()
}

/** Discard every local change. Confirms — this is the one action that loses work. */
export function clearAllTags(): boolean {
  if (!tags.length) { showTagList(); return false }
  if (!confirm(`Discard all ${tags.length} unsaved change(s) in this browser? The committed places stay as they are. Export first if you want to keep them.`)) {
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

/**
 * The whole of `data/curated/places.json`, ready to replace the file.
 *
 * Not just what changed: an edit to a committed place only means anything
 * against the rest of them, and a retired one is removed by being absent. So
 * the export is the merged result — paste it over the file wholesale.
 */
export function exportJson(): string {
  const local = new Map(tags.map((t) => [t.id, t]))
  return JSON.stringify({
    _source: 'survey',
    _note: 'Exported from the map’s editor — the full set, meant to replace this file. Check each row against reality before committing it.',
    items: applyEdits(base).map((p) => ({
      id: p.id,
      name: p.name,
      cat: p.cat,
      lat: p.lat,
      lon: p.lon,
      ...(p.poly?.length ? { poly: p.poly } : {}),
      ...(p.color ? { color: p.color } : {}),
      ...(p.desc ? { desc: p.desc } : {}),
      surveyed: local.get(p.id)?.on ?? (p as { surveyed?: string }).surveyed,
    })),
  }, null, 2)
}

/* ── UI ──────────────────────────────────────────────────────────────────── */

let campus: Campus
let onDone: (() => void) | null = null

export function initTagger(c: Campus) {
  campus = c
  base = c.pois

  const panel = document.getElementById('panel')!
  panel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement

    if (t.closest('[data-tag-save]')) { save(); return }
    if (t.closest('[data-tag-cancel]')) { hide(); return }
    if (t.closest('[data-tag-list]')) { showTagList(); return }
    if (t.closest('[data-tag-export]')) { download(); return }
    if (t.closest('[data-tag-copy]')) { copy(t.closest('[data-tag-copy]') as HTMLElement); return }
    if (t.closest('[data-tag-clear]')) { clearAllTags(); return }
    const revert = t.closest('[data-tag-revert]') as HTMLElement | null
    if (revert) { revertTag(revert.dataset.tagRevert!); showTagList(); return }
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
  // A local record if there is one, otherwise the place as it shipped — the
  // second case is the common one, since the map arrives already full.
  const local = tags.find((x) => x.id === id)
  const shipped = base.find((p) => p.id === id)
  const t: Partial<Tag> | undefined = local ?? (shipped && {
    id: shipped.id, name: shipped.name, cat: shipped.cat,
    lat: shipped.lat, lon: shipped.lon, desc: shipped.desc,
    poly: shipped.poly, color: shipped.color,
  })
  if (!t) return

  pending = { id: t.id!, lat: t.lat!, lon: t.lon!, ...(t.poly ? { poly: t.poly } : {}) }
  onDone = done ?? null
  const what = t.poly?.length ? `outline · ${t.poly.length} points` : 'point'
  form('Edit place', local ? `${what} · changed here` : `${what} · as committed`, t)
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

  // Replace-or-append, rather than map-in-place. Editing a committed place has
  // an id but no local record yet — mapping over the list would find nothing to
  // replace and the edit would vanish without a word.
  tags = [...tags.filter((t) => t.id !== next.id), next]
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
  const local = new Map(tags.map((t) => [t.id, t]))
  const places = applyEdits(base)
  const retired = tags.filter((t) => t.deleted)
  const changed = tags.length

  const row = (p: Poi) => {
    const t = local.get(p.id)
    return `
      <div class="tag-row">
        <span class="dot" style="background:${p.color ?? campus.categories[p.cat]?.color ?? '#8b949e'}"></span>
        <span class="tag-main">
          <b>${esc(p.name)}</b>
          <em>${esc(campus.categories[p.cat]?.label ?? p.cat)}${p.poly?.length ? ' · area' : ''}${
            t ? (isBase(p.id) ? ' · changed' : ' · added') : ''}</em>
        </span>
        <button class="linkish" data-tag-edit="${esc(p.id)}" aria-label="Edit ${esc(p.name)}">edit</button>
        ${t && isBase(p.id)
          ? `<button class="linkish" data-tag-revert="${esc(p.id)}" aria-label="Revert ${esc(p.name)}">revert</button>`
          : ''}
        <button data-tag-del="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">&times;</button>
      </div>`
  }

  const retiredRows = retired.map((t) => `
    <div class="tag-row gone">
      <span class="dot"></span>
      <span class="tag-main"><b>${esc(t.name)}</b><em>retired — left out of the export</em></span>
      <button class="linkish" data-tag-revert="${esc(t.id)}">restore</button>
    </div>`).join('')

  panelShell('Places', `${places.length} on the map · ${changed} changed here`, `
    ${changed
      ? `<p class="p-note"><b>${changed}</b> change(s) live in this browser only.
         Export replaces the whole of <code>data/curated/places.json</code>, so
         a paste and a rebuild makes them everyone's.</p>`
      : `<p class="p-note">Nothing changed yet. Edit any place below, or tap one
         on the map with the surveying tool on.</p>`}

    ${changed ? `<div class="p-actions">
      <button data-tag-export class="primary">Download places.json</button>
      <button data-tag-copy>Copy</button>
    </div>` : ''}

    ${retiredRows}
    <div class="p-sec">On the map</div>
    ${places.map(row).join('')}

    ${changed ? `<div class="p-actions" style="margin-top:14px">
      <button data-tag-clear class="danger">Discard all ${changed} change(s)</button>
    </div>` : ''}`)
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
