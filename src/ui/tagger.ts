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
  /** ISO date the tag was made, so an export says how old its rows are. */
  on: string
}

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
  }))
}

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

let pending: { lat: number; lon: number; near?: string } | null = null

/** Open the form for a point on the map. `near` prefills from a building name. */
export function showTagForm(lat: number, lon: number, near?: string, done?: () => void) {
  pending = { lat, lon, near }
  onDone = done ?? null

  const options = Object.entries(campus.categories)
    .map(([k, v]) => `<option value="${k}"${k === 'academic' ? ' selected' : ''}>${esc(v.label)}</option>`)
    .join('')

  panelShell('Tag this place', `${lat.toFixed(5)}, ${lon.toFixed(5)}`, `
    <div class="tag-form">
      <label for="tag-name">Name</label>
      <input id="tag-name" type="text" autocomplete="off" spellcheck="false"
             placeholder="e.g. Civil Engineering Dept" value="${esc(near ?? '')}">

      <label for="tag-cat">What is it</label>
      <select id="tag-cat">${options}</select>

      <label for="tag-desc">Note <span class="opt">optional</span></label>
      <input id="tag-desc" type="text" autocomplete="off" placeholder="why a student cares">

      <div class="p-actions">
        <button data-tag-save class="primary">Save tag</button>
        <button data-tag-cancel>Cancel</button>
      </div>
    </div>

    <p class="p-note">Saved in this browser only — nothing is uploaded. Export
    the set from <b>My tags</b> in search when you want to commit
    them to <code>data/curated/places.json</code>.</p>

    <p class="src">Somewhere real and permanent? It belongs in OpenStreetMap —
    <a href="https://www.openstreetmap.org/edit#map=19/${lat.toFixed(5)}/${lon.toFixed(5)}"
       target="_blank" rel="noopener">edit this spot →</a> and it arrives here on
    the next build, along with every other map that reads OSM.</p>`)

  const name = document.getElementById('tag-name') as HTMLInputElement | null
  name?.focus()
  name?.select()
}

function save() {
  if (!pending) return
  const name = (document.getElementById('tag-name') as HTMLInputElement).value.trim()
  const cat = (document.getElementById('tag-cat') as HTMLSelectElement).value
  const desc = (document.getElementById('tag-desc') as HTMLInputElement).value.trim()

  if (!name) {
    const el = document.getElementById('tag-name') as HTMLInputElement
    el.focus()
    el.classList.add('bad')
    return
  }

  tags = [...tags, {
    id: slug(name),
    name,
    cat,
    lat: +pending.lat.toFixed(6),
    lon: +pending.lon.toFixed(6),
    ...(desc ? { desc } : {}),
    on: new Date().toISOString().slice(0, 10),
  }]
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
          <span class="dot" style="background:${campus.categories[t.cat]?.color ?? '#8b949e'}"></span>
          <span class="tag-main">
            <b>${esc(t.name)}</b>
            <em>${esc(campus.categories[t.cat]?.label ?? t.cat)} · ${esc(t.on)}</em>
          </span>
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
