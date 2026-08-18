import './styles.css'
import maplibregl from 'maplibre-gl'
import type { Campus, Poi } from './types'
import { buildStyle, applyImagery, IMAGERY } from './map/style'
import { SearchIndex, type Hit } from './search/engine'
import { initPalette, openPalette } from './ui/palette'
import { initPanel, showPoi, hidePanel } from './ui/panel'
import { cycle as cycleTheme, current as themeChoice, onThemeChange, resolved } from './ui/theme'
import { SITE, panBounds } from './config'
import { registerServiceWorker, watchNetwork } from './ui/install'

const boot = document.getElementById('boot')!
const base = import.meta.env.BASE_URL

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${base}data/${path}`)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function start() {
  const [campus, geo] = await Promise.all([
    json<Campus>('campus.json'),
    json<Record<string, GeoJSON.FeatureCollection>>('geo.json'),
  ])

  let pois: Poi[] = []
  let byId = new Map<string, Poi>()
  /** Per-category totals, so a category with nothing in it grows no layer. */
  let counts: Record<string, number> = {}

  /**
    * The committed places with local edits applied. Everything in
    * data/curated/places.json is on the map before you touch anything, so
    * editing mostly means changing one of those rather than one you made this
    * session — the editor keeps those changes here until you export them.
    */
  let mergePlaces: (base: Poi[]) => Poi[] = (b) => b

  function refreshPoiList() {
    pois = mergePlaces(campus.pois)
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
  // A phone gets fewer, smaller labels and tighter marks: 134 places in a band
  // 390px wide is a pile of text otherwise.
  const compact = () => window.matchMedia('(max-width: 760px)').matches

  const map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(geo, resolved(), base, compact()),
    bounds: campus.meta.bbox,
    // Asymmetric on a phone, because the two axes have opposite problems. The
    // campus is a wide band on a tall screen, so vertical room is surplus —
    // spend it keeping the band clear of the header and the thumb search bar.
    // Horizontally there is none to spare, but a little is still owed: a pin
    // flush against the edge has its label run off the screen, and no amount of
    // anchor-dodging can fix that.
    fitBoundsOptions: {
      padding: compact() ? { top: 60, bottom: 84, left: 28, right: 28 } : 24,
    },
    minZoom: 13,
    maxZoom: 19.5,
    maxBounds: panBounds(campus),
    // Attribution is rendered by the page itself (#attrib) instead — same ODbL
    // credit, one place, and it can carry the imagery credit alongside it.
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  })
  map.touchZoomRotate.disableRotation()

  /**
   * `load` fires once and is gone. Everything that waits for it is set up
   * further down, past an `await` for the surveying module — and on a real
   * network that chunk is a round trip, which is long enough for the map to
   * finish loading first. The listener would then be attached to an event that
   * already happened, and the boot overlay would sit there until it timed out
   * with "the map did not finish loading" over a map that had loaded fine.
   * Localhost resolves the import too fast to ever show it.
   *
   * So latch it here, next to the map, and let `whenMapReady` fire immediately
   * for anyone who turns up late.
   */
  let mapReady = false
  map.once('load', () => { mapReady = true })
  const whenMapReady = (fn: () => void) => { if (mapReady) fn(); else map.once('load', fn) }
  // Handle for scripts/verify-browser.mjs and for poking at the map in devtools.
  ;(window as unknown as { __map: maplibregl.Map }).__map = map
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')

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
            color: placeColour(p),
            pin: !!campus.categories[p.cat]?.pin && !p.unnamed,
            // A building is drawn as its outline alone: the departments inside
            // it carry the names, and its own dot would sit on top of them.
            dot: p.cat !== 'building',
            focus: p.id === focusId,
          },
          geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        })),
    }
  }

  /** A place's own tint if it has one, else its category's. */
  function placeColour(p: Poi): string {
    if (!p.color) return catColour(p.cat)
    if (resolved() === 'dark') return p.color
    const n = parseInt(p.color.slice(1), 16)
    return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      .map((c) => Math.round(c * 0.62).toString(16).padStart(2, '0')).join('')
  }

  /** The outlines: buildings, and anything else somebody drew a shape for. */
  function areaFeatures(): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: pois
        .filter((p) => p.poly && p.poly.length >= 3 && (active.has(p.cat) || p.id === focusId))
        .map((p) => {
          const ring = [...p.poly!]
          const [fx, fy] = ring[0]!, [lx, ly] = ring[ring.length - 1]!
          if (fx !== lx || fy !== ly) ring.push(ring[0]!)
          return {
            type: 'Feature' as const,
            id: p.id,
            properties: { id: p.id, cat: p.cat, color: placeColour(p), focus: p.id === focusId },
            geometry: { type: 'Polygon' as const, coordinates: [ring] },
          }
        }),
    }
  }

  function refreshPois() {
    ;(map.getSource('pois') as maplibregl.GeoJSONSource | undefined)?.setData(poiFeatures())
    ;(map.getSource('areas') as maplibregl.GeoJSONSource | undefined)?.setData(areaFeatures())
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
      : '<span class="chips-empty">No places on this map yet — tag one and its layer appears here.</span>'
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
  // The whole of an outline is the target, not just the dot on it. MapLibre
  // fires the dot's handler first where they overlap, and the dot wins: a
  // department inside a building should open the department.
  map.on('click', 'place-fill', (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ['poi-dot'] }).length) return
    const id = e.features?.[0]?.properties?.id as string | undefined
    const p = id ? byId.get(id) : undefined
    if (p) focusPoi(p)
  })
  for (const layer of ['poi-dot', 'poi-label', 'place-fill']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = '' })
  }

  /* ── search ───────────────────────────────────────────────────────────── */

  /** Commands the surveying tool registers for itself once it has loaded. */
  const devActions: Record<string, () => void> = {}

  const hooks = {
    onLayer: (cat: string) => {
      active.has(cat) && active.size === 1 ? active.clear() : active.add(cat)
      refreshPois()
    },
    onAction: (id: string) => {
      if (id === 'layers-all') { cats.forEach(([c]) => active.add(c)); refreshPois() }
      if (id === 'layers-none') { active.clear(); refreshPois() }
      if (id === 'imagery') setImagery(!imagery)
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
    close: () => { focusId = null; refreshPois() },
  })

  initPalette({
    // A getter, not the value: `index` is replaced whenever the tag set changes.
    get index() { return index },
    campus,
    open: openHit,
  })

  /* ── imagery ──────────────────────────────────────────────────────────── */

  // On by default. OpenStreetMap has 38 building footprints inside the wall
  // against a campus full of them, so the drawn map alone is mostly empty
  // ground with pins floating on it; over the photograph every pin sits on the
  // building it names. Switching it off gives the drawn map back.
  let imagery = true

  const imgBtn = document.getElementById('imagery-btn')!
  const credit = document.getElementById('imagery-credit')!

  function setImageryChrome(on: boolean) {
    document.body.classList.toggle('imagery', on)
    imgBtn.setAttribute('aria-pressed', String(on))
    imgBtn.title = on ? 'Aerial imagery on' : 'Aerial imagery off'
    credit.hidden = !on
  }

  function setImagery(on: boolean) {
    imagery = on
    applyImagery(map, on, resolved())
    setImageryChrome(on)
  }
  credit.innerHTML = `· <a href="${IMAGERY.creditUrl}" target="_blank" rel="noopener">imagery ${IMAGERY.credit}</a>`
  // Everything but the map layer itself can be set now; the layer has to wait
  // for the style, which is why `map.on('load')` calls this again.
  setImageryChrome(imagery)
  imgBtn.addEventListener('click', () => setImagery(!imagery))

  // Installable and offline-capable: the worker precaches the whole app, and if
  // the network goes the drawn map stands in for the imagery rather than leaving
  // dimmed fills over nothing.
  registerServiceWorker()
  watchNetwork({ imageryOn: () => imagery, setImagery })

  /* ── surveying ────────────────────────────────────────────────────────── */

  /**
   * The tool the campus is surveyed with: mark a point, or trace an outline,
   * name it, and export the lot into data/curated/places.json.
   *
   * Tags live in this browser's localStorage and nowhere else — there is no
   * server, so what you add here is yours until you export it and commit it.
   */
  {
    const tagger = await import('./ui/tagger')
    tagger.initTagger(campus)
    mergePlaces = tagger.applyEdits

    let tagMode = false
    let tool: 'point' | 'area' = 'point'
    /** Vertices of the outline being traced, [lon, lat]. */
    let draft: [number, number][] = []
    /**
     * A finished outline waiting for its marker. An outline and a marker are
     * separate things — the outline is what a place occupies, the marker is
     * where its dot belongs, which is the door or the counter far more often
     * than it is the middle of the shape. So the marker is tapped, not derived.
     */
    let ringDone: [number, number][] | null = null
    /** Set while an existing place's marker is being moved. */
    let moving: string | null = null

    const tagBtn = document.createElement('button')
    tagBtn.id = 'tag-btn'
    tagBtn.type = 'button'
    tagBtn.setAttribute('aria-pressed', 'false')
    tagBtn.setAttribute('aria-label', 'Add or edit places')
    tagBtn.innerHTML = `
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M8 1.8 C5.5 1.8 3.6 3.7 3.6 6.1 C3.6 9.2 8 14.2 8 14.2 C8 14.2 12.4 9.2 12.4 6.1 C12.4 3.7 10.5 1.8 8 1.8 Z"
              fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
        <path d="M8 4.4 V7.8 M6.3 6.1 H9.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg><span class="n"></span>`
    document.getElementById('bar')!.insertBefore(tagBtn, document.getElementById('layers-btn'))

    // The toolbar only exists while tagging, and says what the next tap will do.
    const bar = document.createElement('div')
    bar.id = 'tag-bar'
    bar.hidden = true
    document.body.append(bar)

    function paintTagBtn() {
      const n = tagger.tagCount()
      tagBtn.querySelector('.n')!.textContent = n ? String(n) : ''
      tagBtn.setAttribute('aria-pressed', String(tagMode))
      tagBtn.title = tagMode ? 'Editing — tap the map to add' : `Add or edit places${n ? ` · ${n} yours` : ''}`
    }

    function paintTagBar() {
      bar.hidden = !tagMode
      if (!tagMode) return

      if (moving) {
        bar.innerHTML = `<span class="say">tap where the marker goes</span>
          <button data-draft-cancel class="x" aria-label="Cancel">&times;</button>`
        return
      }
      if (ringDone) {
        bar.innerHTML = `<span class="say">outline set · now tap where the marker goes</span>
          <button data-marker-centre>use centre</button>
          <button data-draft-cancel class="x" aria-label="Discard outline">&times;</button>`
        return
      }
      bar.innerHTML = `
        <span class="tools">
          <button data-tool="point" class="${tool === 'point' ? 'on' : ''}">point</button>
          <button data-tool="area" class="${tool === 'area' ? 'on' : ''}">area</button>
        </span>
        <span class="say">${
          tool === 'point'
            ? 'tap a spot · tap a place of yours to edit it'
            : draft.length === 0 ? 'tap the corners of the outline'
            : `${draft.length} point${draft.length === 1 ? '' : 's'}${draft.length < 3 ? ' · need 3' : ''}`
        }</span>
        ${tool === 'area' && draft.length ? `
          <button data-draft-undo>undo</button>
          <button data-draft-done class="primary" ${draft.length < 3 ? 'disabled' : ''}>finish</button>
          <button data-draft-cancel class="x" aria-label="Discard outline">&times;</button>` : ''}`
    }

    /** The outline in progress — or the finished one still awaiting a marker. */
    function paintDraft() {
      const src = map.getSource('draft') as maplibregl.GeoJSONSource | undefined
      if (!src) return
      const ring = ringDone ?? draft
      const features: GeoJSON.Feature[] = (ringDone ? [] : draft).map((c, i) => ({
        type: 'Feature',
        properties: { i },
        geometry: { type: 'Point', coordinates: c },
      }))
      if (ring.length >= 2) {
        features.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [...ring, ring[0]!] },
        })
      }
      if (ring.length >= 3) {
        features.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] },
        })
      }
      src.setData({ type: 'FeatureCollection', features })
    }

    function setDraft(next: [number, number][]) {
      draft = next
      paintDraft()
      paintTagBar()
    }

    function setTagMode(on: boolean) {
      tagMode = on
      document.body.classList.toggle('tagging', on)
      if (!on) { ringDone = null; moving = null; setDraft([]) }
      paintTagBtn()
      paintTagBar()
      // You cannot outline a building you cannot see.
      if (on && !imagery) setImagery(true)
    }

    tagBtn.addEventListener('click', () => setTagMode(!tagMode))
    paintTagBtn()

    bar.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const pick = t.closest('[data-tool]') as HTMLElement | null
      if (pick) { tool = pick.dataset.tool as 'point' | 'area'; setDraft([]); return }
      if (t.closest('[data-draft-undo]')) { setDraft(draft.slice(0, -1)); return }
      if (t.closest('[data-draft-cancel]')) { ringDone = null; moving = null; setDraft([]); return }
      if (t.closest('[data-draft-done]')) { finishArea(); return }
      if (t.closest('[data-marker-centre]')) {
        // For a building the marker is never drawn, so the middle is as good a
        // place as any to hang search results and the fly-to off.
        const r = ringDone
        if (!r) return
        openAreaForm(
          r.reduce((a, c) => a + c[1], 0) / r.length,
          r.reduce((a, c) => a + c[0], 0) / r.length,
        )
      }
    })

    function finishArea() {
      if (draft.length < 3) return
      ringDone = draft
      draft = []
      paintDraft()
      paintTagBar()
    }

    /** The outline is settled and the marker has been chosen; name the thing. */
    function openAreaForm(lat: number, lon: number) {
      const ring = ringDone
      if (!ring) return
      ringDone = null
      setDraft([])
      tagger.showTagForm(lat, lon, undefined, () => setTagMode(false), ring)
    }

    tagger.onRequestMovePoint((id) => {
      moving = id
      if (!tagMode) setTagMode(true)
      hidePanel()
      paintTagBar()
    })

    // Handle for scripts/verify-browser.mjs, alongside __map: the list is
    // otherwise only reachable by typing into search, which ranks a fuzzy place
    // match above it and makes the test about ranking instead of about editing.
    ;(window as unknown as { __openTagList: () => void }).__openTagList = () => tagger.showTagList()

    devActions['tag-mode'] = () => setTagMode(!tagMode)
    devActions['tags'] = () => tagger.showTagList()
    devActions['tags-clear'] = () => tagger.clearAllTags()

    map.on('click', (e) => {
      if (!tagMode) return

      // Moving an existing marker, or choosing one for an outline just drawn.
      if (moving) {
        tagger.movePoint(moving, e.lngLat.lng, e.lngLat.lat)
        const id = moving
        moving = null
        paintTagBar()
        tagger.showEditForm(id, () => setTagMode(false))
        return
      }
      if (ringDone) { openAreaForm(e.lngLat.lat, e.lngLat.lng); return }

      if (tool === 'area') {
        setDraft([...draft, [+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)]])
        return
      }

      // Tapping something of your own edits it rather than stacking a second
      // place on top — which is what you meant every time.
      // Anything on the map can be edited — the committed places most of all,
      // since they are what is already here.
      const hit = map.queryRenderedFeatures(e.point, { layers: ['poi-dot', 'place-fill'] })[0]
      const existing = hit?.properties?.id ? byId.get(hit.properties.id as string) : undefined
      if (existing) { tagger.showEditForm(existing.id, () => setTagMode(false)); return }

      const under = map.queryRenderedFeatures(e.point, { layers: ['building'] })[0]
      tagger.showTagForm(e.lngLat.lat, e.lngLat.lng,
                         (under?.properties?.name as string) || undefined,
                         () => setTagMode(false))
    })

    // Categories that had something in them last time the map was painted.
    let known = new Set(Object.keys(counts))

    function applyEdits() {
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
    }

    tagger.onTagsChange(applyEdits)

    // Edits made in an earlier visit are already in storage by the time this
    // module loads, which is after the first paint — without this the map would
    // show the committed places until something else happened to redraw it, and
    // your own changes would look like they had been lost.
    if (tagger.tagCount()) applyEdits()

    // The draft lives in the style, so a theme switch has to refill it.
    onThemeChange(() => setTimeout(paintDraft, 0))
  }

  /* ── chrome ───────────────────────────────────────────────────────────── */

  // The shortcut works on either modifier; the hint should name the one that is
  // actually under the visitor's thumb. Ctrl ships in the markup so the common
  // case never flashes the wrong glyph.
  const uaPlatform = (navigator as unknown as { userAgentData?: { platform?: string } })
    .userAgentData?.platform ?? navigator.platform ?? ''
  if (/mac|iphone|ipad|ipod/i.test(uaPlatform || navigator.userAgent)) {
    const hint = document.querySelector('#open-search kbd')
    if (hint) hint.textContent = '⌘K'
  }


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
    map.setStyle(buildStyle(geo, t, base, compact()))
    map.once('styledata', () => {
      applyImagery(map, imagery, t)
      refreshPois()
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
    const msg = e.error?.message ?? String(e)
    // An unreachable aerial tile is already handled: the service worker tells
    // install.ts, which falls back to the drawn map and says so. Logging one of
    // these per tile on top of that is twenty lines of noise about one fact.
    if (/arcgisonline|offline \(504\)/.test(msg)) return
    // Missing glyphs and the odd tile error are survivable; a style error is not.
    console.error('[map]', msg)
  })

  whenMapReady(() => {
    clearTimeout(bootTimer)
    // The imagery layer only exists once the style is up.
    applyImagery(map, imagery, resolved())
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

start().catch((err) => {
  console.error(err)
  boot.className = 'err'
  boot.textContent = `Could not load campus data — ${err.message}. Run \`npm run build:data\` and reload.`
})
