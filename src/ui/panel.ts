import type { Campus, Poi } from '../types'
import { openNow } from '../search/hours'
import { humanDistance, humanEta } from '../route/router'
import { OSM_CAMPUS_URL, SITE } from '../config'

const el = document.getElementById('panel') as HTMLElement

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export interface PanelHost {
  campus: Campus
  routeTo(lat: number, lon: number, label: string): void
  routeState(): { active: boolean; eta?: number; metres?: number }
  close(): void
}

let host: PanelHost

export function initPanel(h: PanelHost) {
  host = h
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.p-close')) { hidePanel(); host.close() }
    const r = t.closest('[data-route]') as HTMLElement | null
    if (r) host.routeTo(+r.dataset.lat!, +r.dataset.lon!, r.dataset.label!)
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

function routeButtons(lat: number, lon: number, label: string, tagId?: string) {
  const s = host.routeState()
  return `<div class="p-actions">
    <button data-route data-lat="${lat}" data-lon="${lon}" data-label="${esc(label)}"
      class="${s.active ? 'on' : ''}">${s.active && s.eta != null
        ? `${humanEta(s.eta)} · ${humanDistance(s.metres!)}`
        : 'Route here'}</button>
    ${tagId ? `<button data-tag-del="${esc(tagId)}" class="danger">Delete tag</button>` : ''}
  </div>`
}

/* ── places ──────────────────────────────────────────────────────────────── */

export function showPoi(p: Poi) {
  const cat = host.campus.categories[p.cat]
  const wheel = p.wheelchair === 'yes' ? 'step-free'
    : p.wheelchair === 'limited' ? 'limited'
    : p.wheelchair === 'no' ? 'not step-free' : undefined

  const body = [
    // A tag you can see on the map is a tag you should be able to delete from
    // there, without first hunting for it in a list.
    routeButtons(p.lat, p.lon, p.name, p.user ? p.id : undefined),
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
      ? `<p class="src">Your tag, saved in this browser only. See them all in
         <button data-tag-list class="linkish">My tags</button>, or
         <a href="https://www.openstreetmap.org/edit#map=19/${p.lat.toFixed(5)}/${p.lon.toFixed(5)}"
            target="_blank" rel="noopener">put it on OpenStreetMap →</a></p>`
      : `<p class="src">${p.src === 'osm'
        ? `OpenStreetMap · <a href="https://www.openstreetmap.org/${esc(p.osm)}" target="_blank" rel="noopener">${esc(p.osm)}</a>`
        : 'Hand-surveyed — verify before relying on it'}</p>`,
  ].join('')

  shell(p.name, cat?.label ?? p.cat, body)
}

/* ── about ───────────────────────────────────────────────────────────────── */

export function showAbout(campus: Campus) {
  const total = Object.values(campus.meta.counts).reduce((a, b) => a + b, 0)
  const seeded = campus.pois.filter((p) => p.src === 'seed').length

  const body = `
    <p class="p-note">Everything here comes from a public source. Nothing on this
    map is invented — where there is no source, the feature is simply absent.</p>

    <div class="p-sec">Map &amp; places</div>
    ${total === 0
      ? `<p class="p-note">This map deliberately starts with <b>no places on it</b>.
         The ground, the buildings, the paths and the lakes are drawn from
         <a href="${OSM_CAMPUS_URL}" target="_blank" rel="noopener">OpenStreetMap</a> (ODbL),
         but every <em>place</em> — every named, searchable, routable pin — is put
         on by hand. Turn on tag mode in the top bar to add one. Walking and
         cycling times are computed over the OSM path network, so routing works
         from the first tag onwards.</p>`
      : `<p class="p-note"><b>${total}</b> places inside the campus wall, of which
         <b>${total - seeded}</b> come straight from
         <a href="${OSM_CAMPUS_URL}" target="_blank" rel="noopener">OpenStreetMap</a> (ODbL)
         and <b>${seeded}</b> from an on-campus survey. Geometry, opening hours and
         wheelchair tags come from the same extract. Walking and cycling times are
         computed over the OSM path network — no external routing service.</p>`}

    <div class="p-sec">How it is built</div>
    <p class="p-note">One Overpass query per layer, a build step that classifies
    every tagged feature into one of ${Object.keys(campus.categories).length}
    categories, and an A* search over the path graph. The basemap is drawn from
    that same GeoJSON: no tile server and no API key. The only request that ever
    leaves this page is the aerial imagery, and only while you have it switched
    on — those tiles come from Esri's World Imagery, the layer OpenStreetMap's
    own editor uses for tracing.</p>

    <div class="p-sec">Tagging</div>
    <p class="p-note">Found something the map is missing? Turn on tag mode in the
    top bar and tap it. Tags are stored in this browser alone — nothing is
    uploaded — and export as a <code>data/curated/places.json</code> fragment
    from <b>My tags</b> in search. Anything real and permanent is better off in
    OpenStreetMap itself, and every tag form links straight there.</p>

    <div class="p-sec">Coverage is thin — help fix it</div>
    <p class="p-note">${SITE.name} is far less mapped than it deserves. Most of the
    academic blocks are unnamed footprints, and the footpath network barely
    exists, so a walking route may follow the roads rather than the shortcut you
    would actually take. All of that — building names, canteens, water coolers,
    cycle stands, printers, opening hours, step-free entrances — belongs in
    <a href="${OSM_CAMPUS_URL}" target="_blank" rel="noopener">OpenStreetMap</a>.
    Map it once there and it lands here on the next build, and in every other
    map that reads OSM. Switch the aerial layer on to see how much of the campus
    has no footprint drawn over it at all.</p>

    <div class="p-sec">Not here</div>
    <p class="p-note">Faculty directories, mess menus, course timetables, notices
    and bus timings. Each one needs a real, machine-readable source; there is no
    honest way to ship them without one.</p>

    <p class="src">Built ${esc(campus.meta.built)} · ${esc(campus.meta.attribution)}
    · <a href="${esc(SITE.repo)}" target="_blank" rel="noopener">source</a></p>`

  shell(`${SITE.brand.head}${SITE.brand.tail}`, 'About & sources', body)
}
