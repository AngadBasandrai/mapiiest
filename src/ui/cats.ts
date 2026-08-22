import type { Campus, Category } from '../types'
import { panelShell } from './panel'

/**
 * The tag vocabulary, editable from inside the map.
 *
 * The built-in categories are a guess at what a campus needs, made before the
 * survey started. That guess was wrong in both directions — five of them never
 * held a single place, and there was nowhere at all to put a roll shop or a
 * toto stand. A vocabulary you cannot change is a vocabulary you work around,
 * and the way people work around one is by filing things under whatever is
 * closest, which quietly makes the map worse.
 *
 * So: same shape as the place editor. Records live in this browser's
 * localStorage, layer over what the build shipped, and export as
 * `data/curated/categories.json` for a rebuild to make them everyone's.
 * Nothing is uploaded and there is no server.
 */

const KEY = 'campusmap.cats.v1'

export interface CatEdit {
  key: string
  label: string
  color: string
  pin: boolean
  group: string
  /** Drawn as its outline alone. Carried through from the shipped row. */
  area?: true
  /** Retires a built-in. It cannot be removed from the shipped file here. */
  deleted?: true
}

/** Keys are used in exported JSON and in `Poi.cat`, so keep them boring. */
export const KEY_RE = /^[a-z][a-z0-9_-]{0,23}$/

/**
 * Colours to pick from when adding a category.
 *
 * Deliberately a fixed scheme rather than a colour picker. The shipped palette
 * is a solved maximin spread (see scripts/solve-palette.mjs) and a free picker
 * invites a hex that sits on top of one of the 39 already in use — which is
 * exactly the failure the solver exists to prevent. These are the corners of
 * the space it left over, so a new tag lands somewhere legible by default. The
 * form warns if the pick collides anyway.
 */
export const CAT_COLORS: [string, string][] = [
  ['#e8523f', 'Vermilion'], ['#e08a2e', 'Amber'],   ['#c9b52a', 'Mustard'],
  ['#7bbf3a', 'Leaf'],      ['#2fae74', 'Jade'],    ['#2bb3b3', 'Lagoon'],
  ['#3f8fd6', 'Azure'],     ['#6f74e0', 'Iris'],    ['#a45fd6', 'Violet'],
  ['#d45aa8', 'Fuchsia'],   ['#b0705a', 'Terracotta'], ['#8b93a3', 'Slate'],
]

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

let edits: CatEdit[] = read()
const listeners = new Set<() => void>()

let campus: Campus
/** The category set as the build shipped it, before anything local. */
let base: Record<string, Category> = {}
/** Live counts per category, so the manager can say what is in use. */
let counts: () => Record<string, number> = () => ({})

function read(): CatEdit[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw)
      ? raw.filter((c) => c && typeof c.key === 'string' && KEY_RE.test(c.key))
      : []
  } catch {
    return []
  }
}

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(edits))
  } catch {
    alert('Could not save to this browser’s storage — your tag changes will be lost when you close the tab. Export them now.')
  }
  for (const fn of listeners) fn()
}

export function onCatsChange(fn: () => void) { listeners.add(fn) }
export function catEditCount(): number { return edits.length }

export function initCats(c: Campus, liveCounts: () => Record<string, number>) {
  campus = c
  base = c.categories
  counts = liveCounts
}

/** The shipped categories with local edits applied. */
export function mergeCategories(shipped: Record<string, Category>): Record<string, Category> {
  const out: Record<string, Category> = { ...shipped }
  for (const e of edits) {
    if (e.deleted) { delete out[e.key]; continue }
    out[e.key] = {
      label: e.label,
      color: e.color,
      pin: e.pin,
      group: e.group,
      ...(shipped[e.key]?.area ? { area: true } : {}),
    }
  }
  return out
}

export const groupsOf = (): Record<string, string> => campus.groups ?? { service: 'Other' }

/** Category keys in picker order: by group, then as declared within it. */
export function orderedKeys(cats: Record<string, Category>): string[] {
  const groups = Object.keys(groupsOf())
  const rank = (k: string) => {
    const g = cats[k]?.group ?? 'service'
    const i = groups.indexOf(g)
    return i === -1 ? groups.length : i
  }
  const keys = Object.keys(cats)
  return keys.sort((a, b) => rank(a) - rank(b) || keys.indexOf(a) - keys.indexOf(b))
}

/** `<optgroup>`-ed options for a category `<select>`. 40 flat is unreadable. */
export function catOptions(cats: Record<string, Category>, selected: string): string {
  const groups = groupsOf()
  const order = orderedKeys(cats)
  let out = ''
  let open = ''
  for (const k of order) {
    const g = cats[k]!.group ?? 'service'
    if (g !== open) {
      if (open) out += '</optgroup>'
      out += `<optgroup label="${esc(groups[g] ?? 'Other')}">`
      open = g
    }
    out += `<option value="${esc(k)}"${k === selected ? ' selected' : ''}>${esc(cats[k]!.label)}</option>`
  }
  return out + (open ? '</optgroup>' : '')
}

/* ── export ─────────────────────────────────────────────────────────────── */

/**
 * The whole of `data/curated/categories.json`, ready to replace the file.
 *
 * Only rows that differ from the built-in set are written. The alternative —
 * exporting all forty — would freeze today's shipped palette into the curated
 * file, so a later re-solve of the colours in scripts/solve-palette.mjs would
 * land in the repo and then be overridden by this file without a word.
 */
export function exportJson(): string {
  const rows: CatEdit[] = []
  for (const e of edits) {
    if (e.deleted) {
      // A tag that only ever existed locally is removed by being absent; a
      // built-in has to be retired explicitly, since the file cannot unsay it.
      if (base[e.key]) rows.push({ key: e.key, label: e.key, color: '#000000', pin: false, group: 'service', deleted: true })
      continue
    }
    // `area` is not on the form — it is a property of what the category *is*,
    // not a preference — so it has to be carried through from the shipped row
    // or a retuned `building` would come back from the next build without it,
    // silently losing the tint scheme that tells one building from the next.
    rows.push(base[e.key]?.area ? { ...e, area: true } : e)
  }
  return JSON.stringify({
    _source: 'survey',
    _note: 'Exported from the map’s tag manager — the changes against the built-in set in scripts/build-data.mjs, meant to replace this file. A row with deleted:true retires a built-in category.',
    items: rows.map((r) => r.deleted
      ? { key: r.key, deleted: true }
      : {
          key: r.key, label: r.label, color: r.color, pin: r.pin, group: r.group,
          ...(r.area ? { area: true } : {}),
        }),
  }, null, 2)
}

/* ── mutation ───────────────────────────────────────────────────────────── */

export function saveCat(next: CatEdit) {
  edits = [...edits.filter((e) => e.key !== next.key), next]
  write()
}

export function revertCat(key: string) {
  edits = edits.filter((e) => e.key !== key)
  write()
}

/**
 * Retire a category. Places in it are handed to `moveTo` first — a place whose
 * category no longer exists draws an unstyled dot in a layer with no legend
 * chip, which looks like the map losing data rather than a tag being removed.
 */
export function deleteCat(key: string, moveTo?: string) {
  if (moveTo) reassign?.(key, moveTo)
  if (base[key]) {
    edits = [...edits.filter((e) => e.key !== key), {
      key, label: base[key]!.label, color: base[key]!.color,
      pin: false, group: 'service', deleted: true,
    }]
  } else {
    edits = edits.filter((e) => e.key !== key)
  }
  write()
}

/** The place store owns places, so it registers how to move them. */
let reassign: ((from: string, to: string) => void) | null = null
export function onReassign(fn: (from: string, to: string) => void) { reassign = fn }

/* ── UI ─────────────────────────────────────────────────────────────────── */

/** Set while the form is open, so save() knows what it is editing. */
let editing: string | null = null

export function initCatUi() {
  const panel = document.getElementById('panel')!
  panel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-cat-new]')) { showCatForm(); return }
    if (t.closest('[data-cat-save]')) { save(); return }
    if (t.closest('[data-cat-cancel]')) { showCatList(); return }
    if (t.closest('[data-cat-list]')) { showCatList(); return }
    if (t.closest('[data-cat-export]')) { download(); return }
    if (t.closest('[data-cat-copy]')) { copy(t.closest('[data-cat-copy]') as HTMLElement); return }
    const edit = t.closest('[data-cat-edit]') as HTMLElement | null
    if (edit) { showCatForm(edit.dataset.catEdit!); return }
    const rev = t.closest('[data-cat-revert]') as HTMLElement | null
    if (rev) { revertCat(rev.dataset.catRevert!); showCatList(); return }
    const del = t.closest('[data-cat-del]') as HTMLElement | null
    if (del) { askDelete(del.dataset.catDel!); return }
    const conf = t.closest('[data-cat-del-go]') as HTMLElement | null
    if (conf) {
      const to = (document.getElementById('cat-move') as HTMLSelectElement | null)?.value
      deleteCat(conf.dataset.catDelGo!, to || undefined)
      showCatList()
      return
    }
  })

  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).id === 'cat-label') {
      e.preventDefault()
      save()
    }
  })
}

/** How far a candidate colour is from every colour already in use. */
function nearestUse(hex: string, cats: Record<string, Category>, skip: string): { key: string; d: number } | null {
  const lab = (h: string): [number, number, number] => {
    const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    const ch = (i: number) => s2l(parseInt(h.slice(1 + i, 3 + i), 16) / 255)
    const r = ch(0), g = ch(2), b = ch(4)
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * q,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * q,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * q]
  }
  const a = lab(hex)
  let best: { key: string; d: number } | null = null
  for (const [k, v] of Object.entries(cats)) {
    if (k === skip || !/^#[0-9a-f]{6}$/i.test(v.color)) continue
    const o = lab(v.color)
    const d = 100 * Math.hypot(a[0] - o[0], a[1] - o[1], a[2] - o[2])
    if (!best || d < best.d) best = { key: k, d }
  }
  return best
}

export function showCatForm(key?: string) {
  const cats = mergeCategories(base)
  const cur = key ? cats[key] : undefined
  editing = key ?? null

  const groups = groupsOf()
  const chosen = cur?.color ?? CAT_COLORS[0]![0]

  // The tag's current colour leads, and it is only in CAT_COLORS if the tag was
  // made here — a built-in carries a solved hex from the palette, which is
  // deliberately nowhere near these twelve. Without this row nothing would be
  // selected when you open a built-in, and `save` would fall through to the
  // first swatch: renaming "Grocery & kirana" to "Grocery" silently repainted
  // it vermilion. Six tags went the same colour that way before it was caught.
  const inScheme = CAT_COLORS.some(([h]) => h.toLowerCase() === chosen.toLowerCase())
  const swatches = [...(inScheme ? [] : [[chosen, 'Its colour now'] as [string, string]]), ...CAT_COLORS]
    .map(([hexv, name]) =>
      `<button type="button" class="swatch${hexv.toLowerCase() === chosen.toLowerCase() ? ' on' : ''}"
               data-cat-tint="${hexv}" style="background:${hexv}"
               title="${esc(name)}" aria-label="${esc(name)}"></button>`).join('')

  const inUse = key ? (counts()[key] ?? 0) : 0

  panelShell(key ? 'Edit tag' : 'New tag',
             key ? (base[key] ? 'built in' : 'yours') : 'added here', `
    <div class="tag-form">
      <label for="cat-label">Name</label>
      <input id="cat-label" type="text" autocomplete="off"
             placeholder="e.g. Street food & rolls" value="${esc(cur?.label ?? '')}">

      <label for="cat-key">Key <span class="opt">lowercase, no spaces — used in the data file</span></label>
      <input id="cat-key" type="text" autocomplete="off" spellcheck="false"
             placeholder="street" value="${esc(key ?? '')}" ${key ? 'disabled' : ''}>

      <label for="cat-group">Group</label>
      <select id="cat-group">${Object.entries(groups).map(([g, gl]) =>
        `<option value="${esc(g)}"${g === (cur?.group ?? 'service') ? ' selected' : ''}>${esc(gl)}</option>`).join('')}</select>

      <label>Colour</label>
      <div class="swatches" id="cat-tints">${swatches}</div>
      <p class="cat-warn" id="cat-clash" hidden></p>

      <label class="check"><input id="cat-pin" type="checkbox" ${cur?.pin ? 'checked' : ''}>
        Show the name on the map</label>
      <p class="p-note tight">Off, and places in this tag are a dot you have to
      tap. On is for the handful worth reading at a glance — a locality, a
      landmark — and every extra one crowds out a label somewhere else.</p>

      <div class="p-actions">
        <button data-cat-save class="primary">${key ? 'Save changes' : 'Add tag'}</button>
        <button data-cat-cancel>Cancel</button>
      </div>
      ${key ? `<div class="p-actions">
        <button data-cat-del="${esc(key)}" class="danger">Remove this tag${inUse ? ` · ${inUse} in it` : ''}</button>
      </div>` : ''}
    </div>`)

  const tints = document.getElementById('cat-tints')!
  const clash = document.getElementById('cat-clash') as HTMLElement
  const checkClash = () => {
    const hexv = (tints.querySelector('.swatch.on') as HTMLElement | null)?.dataset.catTint
    const near = hexv ? nearestUse(hexv, cats, key ?? '') : null
    // 11.0 is the floor the shipped palette meets; under it, two layers of dots
    // are a coin toss at a glance.
    if (near && near.d < 11) {
      clash.hidden = false
      clash.textContent = `Close to “${cats[near.key]?.label ?? near.key}” (ΔE ${near.d.toFixed(1)}). Usable, but the two will be hard to tell apart on the map.`
    } else {
      clash.hidden = true
    }
  }
  tints.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-cat-tint]') as HTMLElement | null
    if (!b) return
    tints.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on'))
    b.classList.add('on')
    checkClash()
  })
  checkClash()

  // Typing a name suggests a key, until the key is typed into directly.
  const label = document.getElementById('cat-label') as HTMLInputElement
  const keyEl = document.getElementById('cat-key') as HTMLInputElement
  if (!key) {
    let touched = false
    keyEl.addEventListener('input', () => { touched = true })
    label.addEventListener('input', () => {
      if (touched) return
      keyEl.value = label.value.toLowerCase().replace(/&/g, ' ')
        .replace(/[^a-z0-9]+/g, '').slice(0, 24)
    })
  }
  label.focus()
  label.select()
}

function save() {
  const labelEl = document.getElementById('cat-label') as HTMLInputElement
  const keyEl = document.getElementById('cat-key') as HTMLInputElement
  const label = labelEl.value.trim()
  const key = (editing ?? keyEl.value.trim().toLowerCase())
  const group = (document.getElementById('cat-group') as HTMLSelectElement).value
  const pin = (document.getElementById('cat-pin') as HTMLInputElement).checked
  // Falling back to the tag's own colour, not to the first swatch: a fallback
  // that silently repaints is worse than one that changes nothing.
  const color = (document.querySelector('#cat-tints .swatch.on') as HTMLElement | null)
    ?.dataset.catTint ?? (editing ? mergeCategories(base)[editing]?.color : null) ?? CAT_COLORS[0]![0]

  const bad = (el: HTMLInputElement) => { el.focus(); el.classList.add('bad') }
  if (!label) return bad(labelEl)
  if (!KEY_RE.test(key)) return bad(keyEl)
  // A new tag reusing a live key would silently retune that one instead.
  if (!editing && mergeCategories(base)[key]) return bad(keyEl)

  saveCat({ key, label, color: color.toLowerCase(), pin, group })
  editing = null
  showCatList()
}

/** Removing a tag that has places in it asks where they should go first. */
function askDelete(key: string) {
  const cats = mergeCategories(base)
  const n = counts()[key] ?? 0
  const others = orderedKeys(cats).filter((k) => k !== key)

  panelShell(`Remove “${cats[key]?.label ?? key}”?`, n ? `${n} place(s) are in it` : 'nothing is in it', `
    ${n
      ? `<p class="p-note">Those ${n} place(s) have to go somewhere — a place in a
         tag that no longer exists draws a dot with no colour and no legend
         entry, which reads as the map losing them.</p>
         <div class="tag-form">
           <label for="cat-move">Move them to</label>
           <select id="cat-move">${others.map((k) =>
             `<option value="${esc(k)}">${esc(cats[k]!.label)}</option>`).join('')}</select>
         </div>`
      : `<p class="p-note">Nothing is filed under it, so this removes the tag and
         nothing else.</p>`}
    ${base[key] ? `<p class="p-note">It ships in the built-in set, so it is
      recorded as retired here and left out of the export — that is what
      actually removes it once the export is committed.</p>` : ''}
    <div class="p-actions">
      <button data-cat-del-go="${esc(key)}" class="danger">${n ? `Move ${n} and remove` : 'Remove'}</button>
      <button data-cat-cancel>Cancel</button>
    </div>`)
}

export function showCatList() {
  editing = null
  const cats = mergeCategories(base)
  const n = counts()
  const groups = groupsOf()
  const changed = edits.length
  const retired = edits.filter((e) => e.deleted)

  let out = ''
  let open = ''
  for (const k of orderedKeys(cats)) {
    const c = cats[k]!
    const g = c.group ?? 'service'
    if (g !== open) { out += `<div class="p-sec">${esc(groups[g] ?? 'Other')}</div>`; open = g }
    const local = edits.find((e) => e.key === k && !e.deleted)
    out += `
      <div class="tag-row">
        <span class="dot" style="background:${esc(c.color)}"></span>
        <span class="tag-main">
          <b>${esc(c.label)}</b>
          <em>${esc(k)}${n[k] ? ` · ${n[k]} place${n[k] === 1 ? '' : 's'}` : ' · empty'}${
            c.pin ? ' · named on the map' : ''}${
            local ? (base[k] ? ' · changed' : ' · added') : ''}</em>
        </span>
        <button class="linkish" data-cat-edit="${esc(k)}" aria-label="Edit ${esc(c.label)}">edit</button>
        ${local && base[k]
          ? `<button class="linkish" data-cat-revert="${esc(k)}" aria-label="Revert ${esc(c.label)}">revert</button>`
          : ''}
        <button data-cat-del="${esc(k)}" aria-label="Remove ${esc(c.label)}">&times;</button>
      </div>`
  }

  const retiredRows = retired.map((e) => `
    <div class="tag-row gone">
      <span class="dot"></span>
      <span class="tag-main"><b>${esc(base[e.key]?.label ?? e.key)}</b>
        <em>retired — left out of the export</em></span>
      <button class="linkish" data-cat-revert="${esc(e.key)}">restore</button>
    </div>`).join('')

  panelShell('Tags', `${Object.keys(cats).length} tags · ${changed} changed here`, `
    <div class="p-actions">
      <button data-cat-new class="primary">New tag</button>
      <button data-tag-list>Places</button>
    </div>
    ${changed
      ? `<p class="p-note"><b>${changed}</b> change(s) live in this browser only.
         Export replaces the whole of <code>data/curated/categories.json</code>,
         so a paste and a rebuild makes them everyone's.</p>
         <div class="p-actions">
           <button data-cat-export class="primary">Download categories.json</button>
           <button data-cat-copy>Copy</button>
         </div>`
      : `<p class="p-note">These are the built-in tags. Add one for anything the
         survey keeps running into, and remove the ones you never file
         anything under — an empty tag costs a line in this list, but a wrong
         one costs a place filed where nobody will look for it.</p>`}
    ${retiredRows}
    ${out}`)
}

function download() {
  const blob = new Blob([exportJson()], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'categories.json'
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
