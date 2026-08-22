// Loads the built site in a real headless Chrome, on a throwaway profile, and
// fails on any console error, page error or failed request. The unit tests
// cannot catch "the map never appeared"; this can.
//
//   npm run verify              # builds nothing, expects a server on :5180
//   npm run verify -- --url http://localhost:5199
//   npm run verify -- --shot    # also write screenshots to .verify/

import puppeteer from 'puppeteer-core'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argOf = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > -1 ? process.argv[i + 1] : d
}
const URL_ = argOf('url', 'http://localhost:5180/')
const SHOTS = process.argv.includes('--shot')

const campus = JSON.parse(await readFile(join(ROOT, 'public/data/campus.json'), 'utf8'))

// Drive a real place from the current data rather than a hard-coded name, so
// this does not rot when the survey changes. Falls back to a command, which
// always exists, on a map with nothing on it.
const PLACE = campus.pois.find((p) => campus.categories[p.cat]?.pin && p.name.length > 6)
  ?? campus.pois[0]
const QUERY = PLACE?.name ?? 'satellite'

const CHROME = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))

if (!CHROME) {
  console.error('No Chrome found — skipping browser verification.')
  process.exit(0)
}

let failures = 0
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// Throwaway profile so nothing touches the user's real Chrome.
const PROFILE = join(ROOT, 'node_modules/.cache/verify-profile')
await rm(PROFILE, { recursive: true, force: true })
if (SHOTS) await mkdir(join(ROOT, '.verify'), { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  userDataDir: PROFILE,
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})

async function check(name, width, height) {
  console.log(`\n${name} (${width}x${height})`)
  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 1 })

  const errors = []
  const failed = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  // Aerial tiles are a third-party, opt-in extra: a slow or blocked tile server
  // must not fail the build for the site's own assets.
  const ours = (url) => !url.includes('arcgisonline.com')
  page.on('requestfailed', (r) => {
    if (ours(r.url())) failed.push(`${r.url()} ${r.failure()?.errorText}`)
  })
  page.on('response', (r) => {
    if (r.status() >= 400 && ours(r.url())) failed.push(`HTTP ${r.status()} ${r.url()}`)
  })

  // Trip a flag if anything reaches for the Geolocation API. A permission
  // prompt never appears in headless Chrome, so the only way to catch a site
  // that still asks is to watch the call itself.
  await page.evaluateOnNewDocument(() => {
    window.__geoCalled = false
    const g = navigator.geolocation
    if (!g) return
    for (const fn of ['getCurrentPosition', 'watchPosition']) {
      const orig = g[fn].bind(g)
      g[fn] = (...args) => { window.__geoCalled = true; return orig(...args) }
    }
  })

  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 30_000 })

  // The boot overlay only clears once MapLibre fires `load`.
  const booted = await page.waitForFunction(
    () => document.getElementById('boot')?.classList.contains('gone'),
    { timeout: 20_000 },
  ).then(() => true).catch(() => false)

  const bootText = await page.$eval('#boot', (el) => el.textContent?.trim() ?? '')
  ok(booted, 'map finished loading', booted ? '' : `boot still says: "${bootText}"`)
  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '))
  ok(failed.length === 0, 'no failed requests', failed.slice(0, 3).join(' | '))

  // The map must have actually painted something, not just fired `load`.
  const painted = await page.evaluate(() => {
    const c = document.querySelector('#map canvas')
    return c ? c.width > 0 && c.height > 0 : false
  })
  ok(painted, 'map canvas has dimensions')

  // Prove the stylesheet actually applied, rather than merely downloading. A
  // CSS file refused for its MIME type still shows up as a 200 in the network
  // log; only the computed style tells you the truth.
  const css = await page.evaluate(() => {
    const sheets = [...document.styleSheets].filter((s) => {
      try { return s.cssRules.length > 0 } catch { return false }
    }).length
    const bg = getComputedStyle(document.body).backgroundColor
    const tok = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    return { sheets, bg, tok }
  })
  ok(css.sheets > 0 && css.tok !== '', 'stylesheet applied',
     css.tok === '' ? 'design tokens missing — CSS downloaded but not applied' : `--bg ${css.tok}`)
  ok(css.bg !== 'rgba(0, 0, 0, 0)', 'body has a painted background', css.bg)

  // One chip per category that has something in it — so on a map that starts
  // empty the right answer is zero chips and an explanation in their place.
  const dots = await page.evaluate(() =>
    document.querySelectorAll('#layer-chips .chip').length)
  const emptyLegend = await page.evaluate(() =>
    document.querySelector('#layer-chips .chips-empty')?.textContent?.trim() ?? '')
  ok(dots > 3 || emptyLegend !== '',
     dots ? `layer chips rendered (${dots})` : 'empty legend explains itself',
     dots ? '' : emptyLegend)

  // On a phone the legend lives in a sheet behind a toggle; on desktop it is
  // always laid out in the dock. Either way every chip must be reachable and
  // fully on screen — never clipped by a horizontal scroll.
  const sheetMode = await page.evaluate(() =>
    getComputedStyle(document.getElementById('layers-btn')).display !== 'none')

  if (sheetMode) {
    await page.click('#layers-btn')
    // Wait for the slide-up to settle, not just for the class — measuring
    // mid-transition reports every chip as off-screen.
    await page.waitForFunction(() => {
      const el = document.getElementById('layers')
      if (!el.classList.contains('open')) return false
      return el.getBoundingClientRect().bottom <= document.documentElement.clientHeight + 1
    }, { timeout: 3000 })
  }

  const legend = await page.evaluate(() => {
    const box = document.getElementById('layer-chips')
    const chips = [...box.querySelectorAll('.chip')]
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    return {
      hScroll: box.scrollWidth > box.clientWidth + 1,
      offscreen: chips.filter((c) => {
        const r = c.getBoundingClientRect()
        return r.right > vw + 1 || r.left < -1
      }).length,
      belowFold: chips.filter((c) => c.getBoundingClientRect().top > vh).length,
      cols: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().left))).size,
      minTap: Math.round(Math.min(...chips.map((c) => c.getBoundingClientRect().height))),
    }
  })
  ok(!legend.hScroll, `legend does not scroll sideways${sheetMode ? ' (sheet)' : ' (dock)'}`)
  if (dots) {
    ok(legend.offscreen === 0, `all ${dots} chips within the viewport (${legend.cols} columns)`,
       legend.offscreen ? `${legend.offscreen} cut off` : '')
  }
  if (sheetMode) {
    if (dots) {
      ok(legend.minTap >= 34, `chips are tappable (${legend.minTap}px tall)`)
      ok(legend.belowFold === 0, 'no chip starts below the fold',
         legend.belowFold ? `${legend.belowFold} need scrolling` : '')
    }
    await page.click('.layers-close')
    await page.waitForFunction(() =>
      !document.getElementById('layers').classList.contains('open'), { timeout: 2000 })
    ok(true, 'sheet closes')
  }

  // ODbL requires the credit even though the footer link is gone.
  const attrib = await page.evaluate(() => {
    const a = document.querySelector('#attrib a')
    if (!a) return null
    const r = a.getBoundingClientRect()
    return { href: a.getAttribute('href'), visible: r.width > 0 && r.height > 0 }
  })
  ok(attrib?.visible && /openstreetmap\.org/.test(attrib.href ?? ''),
     'OpenStreetMap attribution is present and visible', attrib?.href ?? 'missing')

  // In dock mode the chips sit loose at the bottom-left and must stay clear of
  // the attribution in the opposite corner. In sheet mode the legend is an
  // overlay that covers everything on purpose, so the check does not apply.
  if (!sheetMode) {
    const clash = await page.evaluate(() => {
      const l = document.getElementById('layers')?.getBoundingClientRect()
      const a = document.getElementById('attrib')?.getBoundingClientRect()
      if (!l || !a) return 'missing'
      const overlaps = l.right > a.left && l.left < a.right && l.bottom > a.top && l.top < a.bottom
      return overlaps ? `chips ${l.right.toFixed(0)}px vs attribution ${a.left.toFixed(0)}px` : ''
    })
    ok(clash === '', 'layer chips clear the attribution', clash)
  }

  // The runner is not a Mac, so the hint must name Ctrl — and the search bar
  // should not be advertising "commands" at people looking for a building.
  const searchBar = await page.evaluate(() => ({
    hint: document.querySelector('#open-search kbd')?.textContent?.trim() ?? '',
    placeholder: document.querySelector('#open-search .ph')?.textContent?.trim() ?? '',
  }))
  ok(searchBar.hint === 'Ctrl K', 'the shortcut hint reads Ctrl K off a Mac', searchBar.hint)
  ok(!/command/i.test(searchBar.placeholder), 'the search placeholder does not mention commands',
     searchBar.placeholder)

  // Ctrl and Meta both open it; drive the one this platform advertises.
  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control')
  const paletteOpen = await page.waitForFunction(
    () => document.getElementById('palette') && !document.getElementById('palette').hidden,
    { timeout: 4000 },
  ).then(() => true).catch(() => false)
  ok(paletteOpen, 'palette opens on the shortcut')

  if (paletteOpen) {
    await page.type('#palette-input', QUERY, { delay: 12 })
    await page.waitForFunction(() => document.querySelectorAll('#palette-results .row').length > 0,
      { timeout: 4000 }).catch(() => {})
    const rows = await page.$$eval('#palette-results .row .row-title', (r) => r.map((x) => x.textContent))
    ok(rows.length > 0, `"${QUERY}" returns results (${rows.length})`, rows[0] ?? '')

    // Result text must stay inside the palette box.
    const spill = await page.evaluate(() => {
      const box = document.getElementById('palette-box').getBoundingClientRect()
      return [...document.querySelectorAll('#palette-results .row-title, #palette-results .row-sub')]
        .filter((el) => el.getBoundingClientRect().right > box.right + 1).length
    })
    ok(spill === 0, 'palette rows stay inside the box', spill ? `${spill} overflowing` : '')

    if (SHOTS) await page.screenshot({ path: join(ROOT, `.verify/${name}-palette.png`) })

    // Dismissing the keyboard blurs the input. Tapping it again must refocus,
    // or a phone user is stuck staring at a search box that will not type.
    await page.evaluate(() => document.getElementById('palette-input').blur())
    await page.click('#palette-input')
    const refocused = await page.evaluate(() =>
      document.activeElement?.id === 'palette-input')
    ok(refocused, 'tapping the input refocuses it after a blur')

    // And there must be a way out that needs neither Escape nor a backdrop,
    // because the full-screen phone layout has neither.
    const exitVisible = await page.evaluate(() => {
      const b = document.getElementById('palette-close')
      return b ? getComputedStyle(b).display !== 'none' : false
    })
    ok(!sheetMode || exitVisible, 'a visible close button exists on phones')
    if (exitVisible) {
      await page.click('#palette-close')
      const shut = await page.evaluate(() => document.getElementById('palette').hidden)
      ok(shut, 'close button dismisses the palette')
      // Meta as well as Ctrl, so a Mac visitor is covered by the same run.
      await page.keyboard.down('Meta'); await page.keyboard.press('KeyK'); await page.keyboard.up('Meta')
      await page.waitForFunction(() => !document.getElementById('palette').hidden, { timeout: 3000 })
      await page.type('#palette-input', QUERY, { delay: 8 })
      await page.waitForFunction(() => document.querySelectorAll('#palette-results .row').length > 0,
        { timeout: 4000 }).catch(() => {})
    }

    // Open the top result. On a map with places that is a place, and the panel,
    // the route and the map label all hang off it.
    await page.keyboard.press('Enter')
    const panelUp = await page.waitForFunction(
      () => document.getElementById('panel') && !document.getElementById('panel').hidden,
      { timeout: 4000 },
    ).then(() => true).catch(() => false)
    ok(panelUp, 'selecting a result opens the panel')

    const title = await page.evaluate(() =>
      document.querySelector('#panel h2')?.textContent?.trim() ?? '')
    ok(title === QUERY, 'the panel shows the place that was searched for', title)

    // Labels are the thing a broken glyph URL silently kills.
    const labelled = await page.waitForFunction(
      () => window.__map?.queryRenderedFeatures({ layers: ['poi-label'] }).length > 0,
      { timeout: 15_000 },
    ).then(() => true).catch(() => false)
    const labelCount = await page.evaluate(() =>
      window.__map.queryRenderedFeatures({ layers: ['poi-label'] }).length)
    ok(labelled, `map labels rendering (${labelCount})`,
       labelled ? '' : 'glyphs failed or minzoom too high')

    // Directions hand off to Google Maps. The link has to carry this place's
    // own coordinates and open away from the page, or someone gets sent to
    // whatever Google guessed from a name.
    const dir = await page.evaluate(() => {
      const a = document.querySelector('#panel .p-actions a')
      return a ? { href: a.getAttribute('href'), target: a.getAttribute('target'),
                   rel: a.getAttribute('rel'), text: a.textContent.trim() } : null
    })
    ok(!!dir, 'the panel offers a directions link', dir?.text ?? 'missing')
    if (dir) {
      const m = /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=(-?[\d.]+),(-?[\d.]+)$/
        .exec(dir.href ?? '')
      ok(!!m, 'it is a Google Maps directions URL with coordinates', dir.href ?? '')
      if (m) {
        const [lat, lon] = [+m[1], +m[2]]
        const p = campus.pois.find((p) => p.name === PLACE.name)
        ok(Math.abs(lat - p.lat) < 1e-5 && Math.abs(lon - p.lon) < 1e-5,
           'pointing at this place, not another', `${lat},${lon} vs ${p.lat},${p.lon}`)
      }
      ok(dir.target === '_blank' && /noopener/.test(dir.rel ?? ''),
         'and opens in a new tab safely', `target=${dir.target} rel=${dir.rel}`)
    }

    // The theme toggle is gone: one dark ground, no control and no stored choice.
  const themed = await page.evaluate(() => ({
    btn: !!document.getElementById('theme-btn'),
    attr: document.documentElement.getAttribute('data-theme'),
  }))
  ok(!themed.btn, 'no theme toggle in the header')
  ok(themed.attr === null, 'and nothing stamps a theme on the root', String(themed.attr))

  // Nothing may still be trying to route on the page itself.
    const legacy = await page.evaluate(() => ({
      badge: !!document.getElementById('route-badge'),
      layer: !!window.__map?.getLayer('route-line'),
    }))
    ok(!legacy.badge && !legacy.layer, 'no in-page routing left behind',
       `badge=${legacy.badge} layer=${legacy.layer}`)

    // Surveying is how this map gets its places, not something the published
    // site offers. Nothing here may add, change or remove a place or a tag.
    const editable = await page.evaluate(() => ({
      button: !!document.getElementById('tag-btn'),
      bar: !!document.getElementById('tag-bar'),
      edit: !!document.querySelector('#panel [data-tag-edit]'),
      del: !!document.querySelector('#panel [data-tag-del]'),
      places: localStorage.getItem('campusmap.tags.v1'),
      tags: localStorage.getItem('campusmap.cats.v1'),
    }))
    ok(!editable.button && !editable.bar, 'no surveying controls on the published site',
       `button=${editable.button} toolbar=${editable.bar}`)
    ok(!editable.edit && !editable.del, 'and no edit or delete on a place')
    ok(editable.places === null && editable.tags === null, 'nothing written to editor storage')

    await page.keyboard.press('Escape')
  }


  // This site never asks where you are. Directions are a link to Google Maps,
  // which asks for itself, on its own page.
  const asksForLocation = await page.evaluate(() => ({
    control: !!document.querySelector('.maplibregl-ctrl-geolocate'),
    called: window.__geoCalled === true,
  }))
  ok(!asksForLocation.control && !asksForLocation.called,
     'the page never asks for your location',
     `control=${asksForLocation.control} getCurrentPosition=${asksForLocation.called}`)

  // The wordmark is text now — clicking it must not open anything.
  await page.click('#brand')
  const afterBrandClick = await page.evaluate(() => ({
    tag: document.getElementById('brand')?.tagName,
    panelOpen: !document.getElementById('panel').hidden,
  }))
  ok(afterBrandClick.tag === 'DIV' && !afterBrandClick.panelOpen,
     'the wordmark is inert', `<${afterBrandClick.tag?.toLowerCase()}> panel=${afterBrandClick.panelOpen}`)

  /* ── outlines ──────────────────────────────────────────────────────── */

  // The survey ships 49 outlines and 2 buildings, so this can be checked
  // against real data rather than a shape traced by the test. A building is its
  // area and nothing else; everything else keeps its dot on top; and the whole
  // of an area is the target, not just the pin.
  await page.keyboard.press('Escape')
  {
    const drawn = await page.evaluate(() => {
      const m = window.__map
      const areas = m.getSource('areas')._data.features
      const pois = m.getSource('pois')._data.features
      const byId = new Map(pois.map((f) => [f.properties.id, f.properties]))
      const buildings = areas.filter((f) => f.properties.cat === 'building')
      return {
        areas: areas.length,
        buildings: buildings.length,
        buildingDots: buildings.filter((f) => byId.get(f.properties.id)?.dot).length,
        buildingLabels: buildings.filter((f) => byId.get(f.properties.id)?.pin).length,
        nonBuildingDots: areas.filter((f) => f.properties.cat !== 'building')
          .filter((f) => byId.get(f.properties.id)?.dot).length,
        nonBuildings: areas.filter((f) => f.properties.cat !== 'building').length,
        tinted: buildings.every((f) => /^#[0-9a-f]{6}$/i.test(f.properties.color)),
      }
    })
    ok(drawn.areas > 0, `${drawn.areas} outlines drawn from the survey`)
    ok(drawn.buildings > 0, `${drawn.buildings} of them buildings`)
    ok(drawn.buildingDots === 0, 'a building draws no dot', `${drawn.buildingDots} did`)
    ok(drawn.buildingLabels === 0, 'and no label', `${drawn.buildingLabels} did`)
    ok(drawn.nonBuildingDots === drawn.nonBuildings,
       'everything else keeps its dot on top of its area',
       `${drawn.nonBuildingDots} of ${drawn.nonBuildings}`)
    ok(drawn.tinted, 'every building carries a tint')

    // Click bare area inside a real outline — not its marker, not another
    // place's dot — and it should open that place.
    const spot = await page.evaluate(() => {
      const m = window.__map
      for (const f of m.getSource('areas')._data.features) {
        const ring = f.geometry.coordinates[0].map((c) => m.project(c))
        const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y)
        if (Math.min(...xs) < 0 || Math.max(...xs) > innerWidth) continue
        if (Math.min(...ys) < 0 || Math.max(...ys) > innerHeight) continue
        const inside = (x, y) => {
          let hit = false
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j]
            if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit
          }
          return hit
        }
        for (let x = Math.min(...xs) + 3; x < Math.max(...xs) - 3; x += 4) {
          for (let y = Math.min(...ys) + 3; y < Math.max(...ys) - 3; y += 4) {
            if (!inside(x, y)) continue
            if (m.queryRenderedFeatures([x, y], { layers: ['poi-dot'] }).length) continue
            const name = window.__campusNames?.get(f.properties.id)
            return { x: Math.round(x), y: Math.round(y), id: f.properties.id, name }
          }
        }
      }
      return null
    })
    ok(!!spot, 'found bare area inside an outline to click')
    if (spot) {
      await page.mouse.click(spot.x, spot.y)
      await new Promise((r) => setTimeout(r, 600))
      const opened = await page.evaluate(() => ({
        shown: !document.getElementById('panel').hidden,
        title: document.querySelector('#panel h2')?.textContent ?? '',
      }))
      const expected = campus.pois.find((p) => p.id === spot.id)?.name
      ok(opened.shown && opened.title === expected,
         'clicking bare area opens that place', `${opened.title} (expected ${expected})`)
      await page.keyboard.press('Escape')
    }
  }

  /* ── imagery ───────────────────────────────────────────────────────── */

  await page.keyboard.press('Escape')

  // On by default: OSM has too few building footprints for the drawn map to
  // stand on its own, so the photograph is the ground and the pins sit on it.
  const initial = await page.evaluate(() => ({
    pressed: document.getElementById('imagery-btn').getAttribute('aria-pressed'),
    visible: window.__map?.getLayoutProperty('imagery', 'visibility'),
    campusFill: window.__map?.getPaintProperty('campus', 'fill-opacity'),
    credit: !document.getElementById('imagery-credit').hidden,
    label: window.__map?.getPaintProperty('poi-label', 'text-color'),
    plate: document.body.classList.contains('imagery'),
    areaLayers: !!window.__map?.getLayer('place-fill') && !!window.__map?.getLayer('place-line'),
  }))
  ok(initial.pressed === 'true' && initial.visible === 'visible',
     'imagery is on from the start', initial.visible)
  ok(initial.campusFill === 0, 'ground fills step aside for the photo', `campus fill-opacity ${initial.campusFill}`)
  ok(initial.credit, 'imagery attribution is shown')
  ok(initial.plate, 'map chrome takes its plate backing over the photo')
  ok(initial.areaLayers, 'hand-drawn outlines have their own layers', String(initial.areaLayers))
  // The map's grey-on-dark labels wash out over a photograph; white on a dark
  // halo is what keeps them readable.
  ok(initial.label === '#ffffff', 'labels switch to the over-photo treatment', String(initial.label))

  if (SHOTS) {
    await page.waitForFunction(() => window.__map?.isSourceLoaded('imagery'), { timeout: 15_000 })
      .catch(() => {})
    await new Promise((r) => setTimeout(r, 2500))
    await page.screenshot({ path: join(ROOT, `.verify/${name}-imagery.png`) })
  }

  // Off gives the drawn map back, tint and all.
  await page.click('#imagery-btn')
  const off = await page.evaluate(() => ({
    visible: window.__map?.getLayoutProperty('imagery', 'visibility'),
    campusFill: window.__map?.getPaintProperty('campus', 'fill-opacity'),
    credit: document.getElementById('imagery-credit').hidden,
    label: window.__map?.getPaintProperty('poi-label', 'text-color'),
  }))
  ok(off.visible === 'none' && off.campusFill === 1 && off.credit, 'switching it off restores the drawn map')
  ok(off.label !== '#ffffff', 'and labels return to the drawn-map colour', String(off.label))

  // And back on again, so the toggle is proven in both directions.
  await page.click('#imagery-btn')
  const again = await page.evaluate(() => window.__map?.getLayoutProperty('imagery', 'visibility'))
  ok(again === 'visible', 'and back on again', String(again))

  if (SHOTS) {
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(ROOT, `.verify/${name}.png`) })
  }

  // Late errors (style reload, tile decode) show up after interaction.
  ok(errors.length === 0, 'still no console errors after interaction', errors.slice(0, 3).join(' | '))
  await page.close()
}

/**
 * The webapp claims: installable, and it opens with no network at all.
 *
 * This is the only check that can prove either. A manifest that lists a missing
 * icon still validates; a service worker that registers can still cache nothing.
 * So: load once, cut the network, cold-reload, and require the map to come up
 * with its places on it.
 */
async function checkOfflineApp() {
  console.log('\ninstallable / offline')
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })

  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 30_000 })
  await page.waitForFunction(
    () => document.getElementById('boot')?.classList.contains('gone'), { timeout: 20_000 },
  ).catch(() => {})

  // The manifest has to be fetchable and its icons have to exist — a launcher
  // installs a blank tile otherwise, and nothing else would ever say so.
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]')?.href
    if (!href) return null
    const res = await fetch(href)
    if (!res.ok) return { ok: false, status: res.status }
    const m = await res.json()
    const icons = await Promise.all(m.icons.map(async (i) => {
      const r = await fetch(new URL(i.src, href))
      return r.ok
    }))
    return { ok: true, name: m.name, display: m.display, icons, count: m.icons.length }
  })
  ok(!!manifest?.ok, 'the manifest is linked and fetchable', manifest ? `HTTP ${manifest.status ?? 200}` : 'no link tag')
  if (manifest?.ok) {
    ok(manifest.display === 'standalone', 'it asks for a standalone window', manifest.display)
    ok(manifest.icons.every(Boolean), `all ${manifest.count} declared icons load`,
       manifest.icons.map((v, i) => (v ? '' : `#${i} missing`)).filter(Boolean).join(', '))
  }

  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false }
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg) return { supported: true, registered: false }
    await navigator.serviceWorker.ready
    // Precaching runs in the install step, so give it a moment to finish.
    for (let i = 0; i < 60; i++) {
      const name = (await caches.keys()).find((k) => k.startsWith('iiest-map-'))
      if (name) {
        const keys = await (await caches.open(name)).keys()
        if (keys.length >= 10) {
          return { supported: true, registered: true, cache: name, entries: keys.length,
                   paths: keys.map((k) => new URL(k.url).pathname) }
        }
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return { supported: true, registered: true, entries: 0 }
  })
  ok(sw.registered, 'the service worker registers')
  ok((sw.entries ?? 0) >= 10, `it precaches the app (${sw.entries} entries)`)
  if (sw.paths) {
    // The shell is worthless without the data, and the data is worthless
    // without the glyphs — a map with no labels is not the app.
    const needs = ['campus.json', 'geo.json', '.pbf', '.js', '.css']
    const absent = needs.filter((n) => !sw.paths.some((p) => p.includes(n)))
    ok(absent.length === 0, 'the precache covers data, fonts, script and styles', absent.join(', '))
  }

  /* The actual test. */
  await page.setOfflineMode(true)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
  const booted = await page.waitForFunction(
    () => document.getElementById('boot')?.classList.contains('gone'), { timeout: 25_000 },
  ).then(() => true).catch(() => false)
  // Labels need the glyph atlases and a render pass, so poll rather than
  // reading once — the one-shot version fails on a race, not on a cache miss.
  const labelled = await page.waitForFunction(
    () => window.__map?.queryRenderedFeatures({ layers: ['poi-label'] }).length > 0,
    { timeout: 15_000 },
  ).then(() => true).catch(() => false)
  const state = await page.evaluate(() => ({
    chips: document.querySelectorAll('#layer-chips .chip').length,
    pins: window.__map?.getSource('pois')?._data?.features?.length ?? 0,
    labels: window.__map?.queryRenderedFeatures({ layers: ['poi-label'] }).length ?? 0,
  }))
  ok(booted, 'the map opens with the network cut')
  ok(state.pins > 100, `every place is there offline (${state.pins} pins)`)
  ok(state.chips > 10, `the legend is there offline (${state.chips} chips)`)
  ok(labelled, `labels render offline (${state.labels}) — the glyphs were cached`)

  // Search is the other half of the app, and it is pure client-side work over
  // cached data, so it has to keep working too.
  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control')
  await page.waitForFunction(() => !document.getElementById('palette').hidden, { timeout: 4000 }).catch(() => {})
  await page.type('#palette-input', PLACE.name.slice(0, 12), { delay: 6 })
  await page.waitForFunction(() => document.querySelectorAll('#palette-results .row').length > 0,
    { timeout: 4000 }).catch(() => {})
  const found = await page.$$eval('#palette-results .row-title', (r) => r.map((x) => x.textContent))
  ok(found.length > 0, `search works offline ("${PLACE.name.slice(0, 12)}" -> ${found.length})`, found[0] ?? 'nothing')

  await page.setOfflineMode(false)
  await page.close()
}

/**
 * A second visit, with the service worker already controlling the page.
 *
 * This is the one that matters, and the one every other check misses. On a cold
 * localhost load the map takes longer to come up than a dynamic `import()`
 * takes to resolve, so anything registered after that import still catches the
 * map's `load` event. Warm, it is the other way round: every asset comes from
 * the cache, the style is up within a few milliseconds, and an `import()` still
 * costs at least a macrotask — so `load` fires before its own listener exists,
 * and never fires again.
 *
 * That shipped. The live site sat at "the map did not finish loading" over a
 * map that had loaded perfectly, with its places built and its legend drawn,
 * because one handler was attached a tick too late.
 */
async function checkWarmStart() {
  console.log('\nwarm start (service worker controlling)')
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })

  // First visit: register the worker and let it precache.
  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 60_000 })
  const controlled = await page.waitForFunction(
    () => navigator.serviceWorker?.controller != null, { timeout: 20_000 },
  ).then(() => true).catch(() => false)
  ok(controlled, 'the worker takes control on the first visit')

  // Second visit: every asset from the worker's cache, which is the condition
  // the map's `load` race needs — warm, the style is up within a few
  // milliseconds while a dynamic import() still costs a macrotask.
  //
  // Worth being straight about what this does and does not prove. It exercises
  // a fully cached load, which nothing else here did. It does not force the
  // ordering: request interception cannot reach a worker-served response, so
  // the chunk cannot be held back from out here, and on a fast local disk the
  // map may still lose. The environment that actually failed was the deployed
  // site, so that is what gates this — `npm run verify -- --url https://…`.
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 })

  const booted = await page.waitForFunction(
    () => document.getElementById('boot')?.classList.contains('gone'),
    { timeout: 20_000 },
  ).then(() => true).catch(() => false)
  const state = await page.evaluate(() => ({
    boot: document.getElementById('boot')?.textContent?.trim().slice(0, 60) ?? '',
    pins: window.__map?.getSource('pois')?._data?.features?.length ?? -1,
    chips: document.querySelectorAll('#layer-chips .chip').length,
  }))

  ok(booted, 'the map finishes loading on a warm start', booted ? '' : `boot says: "${state.boot}"`)
  // The giveaway when it went wrong: the legend was built from the same list
  // the map draws from, so chips without pins means the draw never happened.
  ok(state.pins > 0, `and draws its places (${state.pins} pins, ${state.chips} chips)`)
  ok(errors.length === 0, 'with no page errors', errors.slice(0, 2).join(' | '))

  await page.close()
}

// One ground, so one pass per viewport rather than one per viewport per theme.
await check('desktop', 1440, 900)
await check('mobile', 402, 874)
await checkWarmStart()
await checkOfflineApp()

await browser.close()
await rm(PROFILE, { recursive: true, force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nbrowser verification passed\n')
process.exit(failures ? 1 : 0)
