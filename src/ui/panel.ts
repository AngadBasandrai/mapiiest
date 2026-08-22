import type { Campus, Poi } from '../types'
import { openNow } from '../search/hours'

const el = document.getElementById('panel') as HTMLElement

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export interface PanelHost {
  campus: Campus
  close(): void
}

let host: PanelHost

export function initPanel(h: PanelHost) {
  host = h
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.p-close')) { hidePanel(); host.close() }
  })
}

export function hidePanel() { el.hidden = true }

/** Render arbitrary content into the panel — used by the tagger's own forms. */
export function panelShell(title: string, kind: string, body: string) {
  shell(title, kind, body)
}

function shell(title: string, kind: string, body: string) {
  el.hidden = false
  el.innerHTML = `
    <div class="p-grip" aria-hidden="true"></div>
    <div class="p-head">
      <div>
        <h2>${esc(title)}</h2>
        <div class="p-kind">${esc(kind)}</div>
      </div>
      <button class="p-close" aria-label="Close">&times;</button>
    </div>
    <div class="p-body">${body}</div>`
  el.querySelector('.p-body')!.scrollTop = 0
}

function kv(rows: [string, string | undefined][]) {
  const live = rows.filter(([, v]) => v)
  if (!live.length) return ''
  return `<dl class="kv">${live.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
}

function hoursRow(spec?: string): string | undefined {
  if (!spec) return undefined
  const st = openNow(spec)
  const badge = st === null ? ''
    : st.open ? ` <span class="ok">· open${st.until ? ` till ${st.until}` : ''}</span>`
    : ` <span class="bad">· closed${st.next ? ` · opens ${st.next}` : ''}</span>`
  return `${esc(spec)}${badge}`
}

/**
 * Directions are handed off to Google Maps rather than drawn here.
 *
 * The campus footpath network barely exists in OpenStreetMap — 34 road segments
 * and a single footway inside the wall — so a route computed over it would send
 * people the long way round with a confident ETA attached. Google has the paths
 * and, more to the point, has the visitor's own position without this site ever
 * asking for it. Coordinates rather than the name: the name would be a guess at
 * whatever Google's index thinks it means, the coordinates are the surveyed
 * spot.
 */
function actions(lat: number, lon: number, id: string) {
  const dest = `${lat.toFixed(6)},${lon.toFixed(6)}`
  return `<div class="p-actions">
    <a class="primary" target="_blank" rel="noopener"
       href="https://www.google.com/maps/dir/?api=1&amp;destination=${dest}">Route in Google Maps</a>
    <button data-tag-edit="${esc(id)}">Edit</button>
  </div>`
}

/* ── places ──────────────────────────────────────────────────────────────── */

export function showPoi(p: Poi) {
  const cat = host.campus.categories[p.cat]
  const wheel = p.wheelchair === 'yes' ? 'step-free'
    : p.wheelchair === 'limited' ? 'limited'
    : p.wheelchair === 'no' ? 'not step-free' : undefined

  const body = [
    // Whatever you are looking at is what you want to correct, so the way in
    // is here rather than somewhere you have to go and find it.
    actions(p.lat, p.lon, p.id),
    kv([
      ['Hours', hoursRow(p.hours)],
      ['Access', wheel ? esc(wheel) : undefined],
      ['Type', p.kind ? esc(p.kind.replace(/_/g, ' ')) : undefined],
      ['Cuisine', p.cuisine ? esc(p.cuisine.replace(/;/g, ', ')) : undefined],
      ['Capacity', p.capacity ? esc(p.capacity) : undefined],
      ['Covered', p.covered ? esc(p.covered) : undefined],
      ['Operator', p.operator ? esc(p.operator) : undefined],
      ['Price', p.price ? esc(p.price) : undefined],
      ['Potable', p.potable === 'no' ? 'no — not drinking water' : undefined],
      ['Phone', p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : undefined],
      ['Website', p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\//, '').slice(0, 34))}</a>` : undefined],
      ['Near', p.near ? esc(p.near) : undefined],
    ]),
    p.desc ? `<p class="p-note">${esc(p.desc)}</p>` : '',
    p.user
      ? `<p class="src">Changed in this browser and not yet committed. See every
         change in <button data-tag-list class="linkish">Places</button>, or
         <a href="https://www.openstreetmap.org/edit#map=19/${p.lat.toFixed(5)}/${p.lon.toFixed(5)}"
            target="_blank" rel="noopener">put it on OpenStreetMap →</a></p>`
      : `<p class="src">${p.src === 'osm'
        ? `OpenStreetMap · <a href="https://www.openstreetmap.org/${esc(p.osm)}" target="_blank" rel="noopener">${esc(p.osm)}</a>`
        : 'Hand-surveyed — verify before relying on it'}</p>`,
  ].join('')

  shell(p.name, cat?.label ?? p.cat, body)
}
