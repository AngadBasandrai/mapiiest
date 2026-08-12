import './styles.css'
import maplibregl from 'maplibre-gl'
import type { Campus, Graph, Poi, Profile } from './types'
import { buildStyle, applyImagery, IMAGERY } from './map/style'
import { Router, humanEta, humanDistance } from './route/router'
import { SearchIndex, type Hit } from './search/engine'
import { initPalette, openPalette } from './ui/palette'
import { initPanel, showAbout, showPoi, hidePanel } from './ui/panel'
import { cycle as cycleTheme, current as themeChoice, onThemeChange, resolved } from './ui/theme'
import { SITE, onCampus, panBounds } from './config'

const boot = document.getElementById('boot')!
const base = import.meta.env.BASE_URL

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${base}data/${path}`)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function start() {
  const [campus, geo, graphData] = await Promise.all([
    json<Campus>('campus.json'),
    json<Record<string, GeoJSON.FeatureCollection>>('geo.json'),
    json<Graph>('graph.json'),
  ])

  const router = new Router(graphData)

  let pois: Poi[] = []
  let byId = new Map<string, Poi>()
  /** Per-category totals, so a category with nothing in it grows no layer. */
  let counts: Record<string, number> = {}

  /**
   * Places from the in-browser tagger, which exists in a dev build only. The
   * survey it was built for is finished and committed to data/curated, so the
   * published site has no way to add or remove anything — it just shows what
   * the build produced.
   */
  let taggedPois: () => Poi[] = () => []

  function refreshPoiList() {
    pois = [...campus.pois, ...taggedPois()]
    byId = new Map(pois.map((p) => [p.id, p]))
    counts = {}
    for (const p of pois) counts[p.cat] = (counts[p.cat] ?? 0) + 1
  }
  refreshPoiList()

  // The category palette is tuned for a dark ground; several hues wash out on
  // white. Darken them for the light theme rather than keeping two hand-written
  // palettes in sync.
  const shadeCache = new Map<string, string>()
  function catColour(cat: string): string {
    const base = campus.categories[cat]?.color ?? '#8b949e'
    if (resolved() === 'dark') return base
    const hit = shadeCache.get(base)
    if (hit) return hit
    const n = parseInt(base.slice(1), 16)
    const mix = (c: number) => Math.round(c * 0.62)
    const out = '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      .map((c) => mix(c).toString(16).padStart(2, '0')).join('')
    shadeCache.set(base, out)
    return out
  }

  /* ── map ──────────────────────────────────────────────────────────────── */

  // Open on the campus itself rather than a fixed zoom: a hard-coded level
  // that frames one campus leaves the next one as a small island in an empty
  // viewport, since nothing outside the boundary is in this extract.
  const map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(geo, campus, resolved(), base),
    bounds: campus.meta.bbox,
    fitBoundsOptions: { padding: 24 },
    minZoom: 13,
    maxZoom: 19.5,
    maxBounds: panBounds(campus),
    // Attribution lives in the page footer instead — same ODbL credit, one place.
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  })
  map.touchZoomRotate.disableRotation()
  // Handle for scripts/verify-browser.mjs and for poking at the map in devtools.
  ;(window as unknown as { __map: maplibregl.Map }).__map = map
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
  })
  map.addControl(geolocate, 'bottom-right')

  /* ── layer state ──────────────────────────────────────────────────────── */

  // Everything on by default — a student looking for a water cooler should not
  // have to discover a layer toggle first.
  const active = new Set(Object.keys(campus.categories).filter((c) => counts[c]))
  let focusId: string | null = null

  function poiFeatures(): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: pois
        .filter((p) => active.has(p.cat) || p.id === focusId)
        .map((p) => ({
          type: 'Feature' as const,
          id: p.id,
          properties: {
            id: p.id,
            name: p.name,
            cat: p.cat,
            color: catColour(p.cat),
            pin: !!campus.categories[p.cat]?.pin && !p.unnamed,
            focus: p.id === focusId,
          },
          geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        })),
    }
  }

  function refreshPois() {
    ;(map.getSource('pois') as maplibregl.GeoJSONSource | undefined)?.setData(poiFeatures())
    // Tint building footprints belonging to visible categories.
    if (map.getLayer('building-cat')) {
      map.setFilter('building-cat', ['all',
        ['!=', ['get', 'cat'], ''],
        ['in', ['get', 'cat'], ['literal', [...active]]],
      ])
    }
    paintChips()
  }

  /* ── layer chips ──────────────────────────────────────────────────────── */

  const rail = document.getElementById('layers')!
  let cats: [string, typeof campus.categories[string]][] = []

  const chipBox = document.getElementById('layer-chips')!
  const layersBtn = document.getElementById('layers-btn')!

  function paintRail() {
    cats = Object.entries(campus.categories)
      .filter(([c]) => counts[c])
      .sort((a, b) => (counts[b[0]] ?? 0) - (counts[a[0]] ?? 0))
    // A category only exists once something is in it, so on a map with no
    // places yet there is nothing to legend — say what to do instead.
    chipBox.innerHTML = cats.length
      ? cats.map(([c, meta]) =>
          `<button class="chip" data-cat="${c}" aria-pressed="false" style="color:${catColour(c)}"
             title="${meta.label} · ${counts[c]}">
             <span class="dot"></span>${meta.label}<span class="n">${counts[c]}</span>
           </button>`).join('')
      : `<span class="chips-empty">No places on this map yet.${
          import.meta.env.DEV ? ' Tag one and its layer appears here.' : ''}</span>`
    paintChips()
  }
  paintRail()

  function paintChips() {
    chipBox.querySelectorAll<HTMLElement>('.chip').forEach((c) =>
      c.setAttribute('aria-pressed', String(active.has(c.dataset.cat!))))
    layersBtn.querySelector('.n')!.textContent = `${active.size}`
    layersBtn.setAttribute('aria-label', `Layers — ${active.size} of ${cats.length} shown`)
  }

  rail.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.layers-close')) { closeLayers(); return }
    if (t.closest('[data-all]')) { cats.forEach(([c]) => active.add(c)); refreshPois(); return }
    if (t.closest('[data-none]')) { active.clear(); refreshPois(); return }
    const chip = t.closest('.chip') as HTMLElement | null
    if (!chip) return
    const c = chip.dataset.cat!
    active.has(c) ? active.delete(c) : active.add(c)
    refreshPois()
  })

  // The sheet only exists on narrow screens; on desktop the chips are always
  // laid out in the dock and the button is hidden.
  const scrim = document.createElement('div')
  scrim.id = 'layers-scrim'
  scrim.hidden = true
  document.body.append(scrim)

  function openLayers() {
    rail.classList.add('open')
    scrim.hidden = false
    layersBtn.setAttribute('aria-expanded', 'true')
  }
  function closeLayers() {
    rail.classList.remove('open')
    scrim.hidden = true
    layersBtn.setAttribute('aria-expanded', 'false')
  }
  layersBtn.addEventListener('click', () =>
    rail.classList.contains('open') ? closeLayers() : openLayers())
  scrim.addEventListener('click', closeLayers)

  /* ── routing ──────────────────────────────────────────────────────────── */

  let profile: Profile = 'foot'
  let origin: { lat: number; lon: number; label: string } | null = null
  let target: { lat: number; lon: number; label: string } | null = null
  /** Metrics of the last successful route, so the panel button can show the ETA. */
  let lastRoute: { seconds: number; metres: number } | null = null

  const badge = document.createElement('div')
  badge.id = 'route-badge'
  badge.hidden = true
  document.body.append(badge)

  function clearRoute() {
    target = null
    lastRoute = null
    badge.hidden = true
    ;(map.getSource('route') as maplibregl.GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: [] })
  }

  function drawRoute() {
    if (!target) return
    const from = origin ?? campusCentreNode()
    const r = router.route(from, target, profile)
    const src = map.getSource('route') as maplibregl.GeoJSONSource | undefined

    if (!r) {
      lastRoute = null
      badge.hidden = false
      badge.innerHTML = `<span>No path found on the mapped network</span>
        <button class="x" data-clear aria-label="Clear route">&times;</button>`
      src?.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    lastRoute = { seconds: r.seconds, metres: r.metres }

    src?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } }],
    })

    const notes = [
      r.steps ? 'steps' : '',
      r.unpaved ? 'unpaved shortcut' : '',
      r.indoor ? 'indoor corridor' : '',
    ].filter(Boolean).join(' · ')

    badge.hidden = false
    badge.innerHTML = `
      <span class="eta">${humanEta(r.seconds)}</span>
      <span>${humanDistance(r.metres)}</span>
      <span class="mode">
        <button data-mode="foot" class="${profile === 'foot' ? 'on' : ''}">walk</button>
        <button data-mode="bike" class="${profile === 'bike' ? 'on' : ''}">cycle</button>
      </span>
      <span class="via">${origin ? '' : 'from campus centre · '}to ${escapeHtml(target.label)}${notes ? ` · ${notes}` : ''}</span>
      <button class="x" data-clear aria-label="Clear route">&times;</button>`

    map.fitBounds(bounds(r.coords), { padding: { top: 80, bottom: 110, left: 60, right: 380 }, maxZoom: 17.5 })
  }

  badge.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.dataset.clear !== undefined) { clearRoute(); return }
    if (t.dataset.mode) { profile = t.dataset.mode as Profile; drawRoute() }
  })

  function campusCentreNode() {
    return { lat: campus.meta.center[1], lon: campus.meta.center[0], label: 'campus centre' }
  }

  function routeTo(lat: number, lon: number, label: string) {
    target = { lat, lon, label }
    drawRoute()
  }

  // Use the browser's location as the route origin when it is on campus.
  map.on('load', () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords
        if (onCampus(campus, lat, lon)) {
          origin = { lat, lon, label: 'you' }
          if (target) drawRoute()
        }
      },
      () => {},
      { timeout: 6000, maximumAge: 120_000 },
    )

    // Switch the locate control on for anyone who has already granted the
    // permission, so the blue dot is there without being asked for. Only when
    // it is already granted: `prompt` would throw a permission dialog at every
    // first-time visitor before they have seen the map, and `denied` would put
    // the control into its error state for no reason.
    navigator.permissions?.query({ name: 'geolocation' })
      .then((status) => { if (status.state === 'granted') geolocate.trigger() })
      .catch(() => {}) // Safari and friends: no permissions API, so leave it off
  })

  /* ── selection ────────────────────────────────────────────────────────── */

  /** Nudge the map so the focused point is not hidden by the panel or sheet. */
  function panelOffset(): [number, number] {
    return window.matchMedia('(max-width: 760px)').matches ? [0, -110] : [-140, 0]
  }

  function focusPoi(p: Poi, zoom = 17.4) {
    focusId = p.id
    refreshPois()
    map.easeTo({
      center: [p.lon, p.lat],
      zoom: Math.max(map.getZoom(), zoom),
      duration: 520,
      offset: panelOffset(),
    })
    showPoi(p)
  }

  map.on('click', 'poi-dot', (e) => {
    const id = e.features?.[0]?.properties?.id as string | undefined
    const p = id ? byId.get(id) : undefined
    if (p) focusPoi(p)
  })
  for (const layer of ['poi-dot', 'poi-label']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = '' })
  }

  /* ── search ───────────────────────────────────────────────────────────── */

  /** Commands the dev-only tagger registers for itself. Empty in a build. */
  const devActions: Record<string, () => void> = {}

  const hooks = {
    onLayer: (cat: string) => {
      active.has(cat) && active.size === 1 ? active.clear() : active.add(cat)
      refreshPois()
    },
    onAction: (id: string) => {
      if (id === 'layers-all') { cats.forEach(([c]) => active.add(c)); refreshPois() }
      if (id === 'layers-none') { active.clear(); refreshPois() }
      if (id === 'clear-route') clearRoute()
      if (id === 'about') showAbout(campus)
      if (id === 'imagery') setImagery(!imagery)
      if (id === 'locate') {
        navigator.geolocation?.getCurrentPosition((pos) =>
          map.easeTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 17 }))
      }
      devActions[id]?.()
    },
  }

  // The index is rebuilt rather than mutated when you tag something — it is a
  // few dozen documents on this campus, so the honest thing is also the cheap
  // one.
  const searchable = (): Campus => ({ ...campus, pois, meta: { ...campus.meta, counts } })
  let index = new SearchIndex(searchable(), hooks)

  function openHit(hit: Hit) {
    if (hit.run) { hit.run(); return }
    if (hit.kind === 'place' && hit.poi) focusPoi(hit.poi)
  }

  initPanel({
    campus,
    routeTo,
    routeState: () => ({
      active: !!target,
      eta: lastRoute?.seconds,
      metres: lastRoute?.metres,
    }),
    close: () => { focusId = null; refreshPois() },
  })

  initPalette({
    // A getter, not the value: `index` is replaced whenever the tag set changes.
    get index() { return index },
    campus,
    open: openHit,
    routeTo: (hit) => { if (hit.lat != null) routeTo(hit.lat, hit.lon!, hit.title) },
  })

  /* ── imagery ──────────────────────────────────────────────────────────── */

  // Aerial imagery is the honest answer to "why is half the campus missing":
  // it is not mapped in OpenStreetMap yet.
  let imagery = false

  const imgBtn = document.getElementById('imagery-btn')!
  const credit = document.getElementById('imagery-credit')!

  function setImagery(on: boolean) {
    imagery = on
    applyImagery(map, on)
    document.body.classList.toggle('imagery', on)
    imgBtn.setAttribute('aria-pressed', String(on))
    imgBtn.title = on ? 'Aerial imagery on' : 'Aerial imagery off'
    credit.hidden = !on
  }
  credit.innerHTML = `· <a href="${IMAGERY.creditUrl}" target="_blank" rel="noopener">imagery ${IMAGERY.credit}</a>`
  credit.hidden = true
  imgBtn.addEventListener('click', () => setImagery(!imagery))

  /* ── surveying (development only) ─────────────────────────────────────── */

  /**
   * The tool the campus was surveyed with: tap the map, name what is there,
   * export the lot into data/curated/places.json. That work is done and
   * committed, so it has no business on the published site — this whole block
   * and the module it pulls in are dropped from a production build.
   *
   * A dynamic import is what makes that true: a static one would keep the
   * module in the bundle regardless, since it touches localStorage as it loads.
   */
  if (import.meta.env.DEV) {
    const tagger = await import('./ui/tagger')
    tagger.initTagger(campus)
    taggedPois = tagger.tagPois

    let tagMode = false

    const tagBtn = document.createElement('button')
    tagBtn.id = 'tag-btn'
    tagBtn.type = 'button'
    tagBtn.setAttribute('aria-pressed', 'false')
    tagBtn.setAttribute('aria-label', 'Tag a missing place')
    tagBtn.innerHTML = `
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M8 1.8 C5.5 1.8 3.6 3.7 3.6 6.1 C3.6 9.2 8 14.2 8 14.2 C8 14.2 12.4 9.2 12.4 6.1 C12.4 3.7 10.5 1.8 8 1.8 Z"
              fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
        <path d="M8 4.4 V7.8 M6.3 6.1 H9.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg><span class="n"></span>`
    document.getElementById('bar')!.insertBefore(tagBtn, document.getElementById('layers-btn'))

    const paintTagBtn = () => {
      const n = tagger.tagCount()
      tagBtn.querySelector('.n')!.textContent = n ? String(n) : ''
      tagBtn.setAttribute('aria-pressed', String(tagMode))
      tagBtn.title = tagMode
        ? 'Tag mode on — tap the map to add a place'
        : `Add missing places${n ? ` · ${n} tagged` : ''}`
    }

    const setTagMode = (on: boolean) => {
      tagMode = on
      document.body.classList.toggle('tagging', on)
      paintTagBtn()
      // Imagery makes tagging possible at all — you cannot mark a building you
      // cannot see — so the first time in, turn it on.
      if (on && !imagery) setImagery(true)
    }
    tagBtn.addEventListener('click', () => setTagMode(!tagMode))
    paintTagBtn()

    devActions['tag-mode'] = () => setTagMode(!tagMode)
    devActions['tags'] = () => tagger.showTagList()
    devActions['tags-clear'] = () => tagger.clearAllTags()

    map.on('click', (e) => {
      if (!tagMode) return
      // A building under the cursor gives the form a name to start from, and
      // tells you the footprint is already mapped even if it is nameless.
      const hit = map.queryRenderedFeatures(e.point, { layers: ['building'] })[0]
      const near = (hit?.properties?.name as string) || undefined
      tagger.showTagForm(e.lngLat.lat, e.lngLat.lng, near, () => setTagMode(false))
    })

    // Categories that had something in them last time the map was painted.
    let known = new Set(Object.keys(counts))

    tagger.onTagsChange(() => {
      refreshPoiList()
      // Switch on a category the first time it gains a member, so a tag is
      // never saved into an invisible layer — but leave the rest of the
      // toggles alone, or every tag would undo what the user chose to look at.
      for (const c of Object.keys(counts)) if (!known.has(c)) active.add(c)
      for (const c of [...active]) if (!counts[c]) active.delete(c)
      known = new Set(Object.keys(counts))

      index = new SearchIndex(searchable(), hooks)
      paintRail()
      refreshPois()
      paintTagBtn()
    })
  }

  /* ── chrome ───────────────────────────────────────────────────────────── */

  const brand = document.getElementById('brand-btn')!
  brand.addEventListener('click', () => showAbout(campus))
  // What is loaded is stated in the About panel; this is the one-line version.
  brand.title = campus.pois.length
    ? `${campus.pois.length} places — click for sources`
    : 'No places yet — click for how this map is built'

  /* ── theme ────────────────────────────────────────────────────────────── */

  const themeBtn = document.getElementById('theme-btn')!
  const GLYPH = { auto: '◐', light: '○', dark: '●' }
  const paintThemeBtn = () => {
    const c = themeChoice()
    themeBtn.textContent = GLYPH[c]
    themeBtn.title = `Theme: ${c}`
  }
  paintThemeBtn()
  themeBtn.addEventListener('click', () => { cycleTheme(); paintThemeBtn() })

  onThemeChange((t) => {
    shadeCache.clear()
    paintRail()
    // setStyle swaps the basemap wholesale, so the two dynamic sources have to
    // be refilled once the new style is live.
    map.setStyle(buildStyle(geo, campus, t, base))
    map.once('styledata', () => {
      applyImagery(map, imagery)
      refreshPois()
      if (target) drawRoute()
    })
  })

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !document.getElementById('palette')!.hidden) return
    if (rail.classList.contains('open')) { closeLayers(); return }
    hidePanel(); focusId = null; refreshPois()
  })

  // A style or asset failure otherwise leaves the boot overlay up forever, which
  // reads as "the site never loads" with nothing on screen to explain it.
  const bootTimer = setTimeout(() => {
    if (boot.classList.contains('gone')) return
    boot.className = 'err'
    boot.textContent = `The map did not finish loading. Check the browser console — and please open an issue at ${SITE.repo}.`
  }, 12_000)

  map.on('error', (e) => {
    // Missing glyphs and the odd tile error are survivable; a style error is not.
    console.error('[map]', e.error?.message ?? e)
  })

  map.on('load', () => {
    clearTimeout(bootTimer)
    refreshPois()
    boot.classList.add('gone')
    // Deep link: ?q=… opens the palette pre-filled, ?id=… focuses a place.
    const params = new URLSearchParams(location.search)
    const id = params.get('id')
    const q = params.get('q')
    if (id && byId.has(id)) focusPoi(byId.get(id)!)
    else if (q) openPalette(q)
  })
}

function bounds(coords: [number, number][]): [[number, number], [number, number]] {
  let w = 180, s = 90, e = -180, n = -90
  for (const [lon, lat] of coords) {
    w = Math.min(w, lon); e = Math.max(e, lon)
    s = Math.min(s, lat); n = Math.max(n, lat)
  }
  return [[w, s], [e, n]]
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

start().catch((err) => {
  console.error(err)
  boot.className = 'err'
  boot.textContent = `Could not load campus data — ${err.message}. Run \`npm run build:data\` and reload.`
})
