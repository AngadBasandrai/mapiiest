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

async function check(name, width, height, theme) {
  console.log(`\n${name} (${width}x${height}${theme ? `, ${theme}` : ''})`)
  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  if (theme) {
    await page.evaluateOnNewDocument((t) => {
      try { localStorage.setItem('campusmap.theme', t) } catch {}
    }, theme)
  }

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

    const hasRoute = await page.$('#panel [data-route]') !== null
    ok(hasRoute, 'panel offers a route button')
    if (hasRoute) {
      await page.click('#panel [data-route]')
      const routed = await page.waitForFunction(
        () => { const b = document.getElementById('route-badge'); return b && !b.hidden },
        { timeout: 4000 },
      ).then(() => true).catch(() => false)
      const eta = await page.evaluate(() =>
        document.querySelector('#route-badge .eta')?.textContent ?? '')
      ok(routed && eta !== '', 'routing draws a path with an ETA', eta)

      // The badge is centred on the same edge the legend is anchored to, and
      // it draws on top — a wide legend disappears under it without this.
      if (!sheetMode) {
        const hidden = await page.evaluate(() => {
          const b = document.getElementById('route-badge').getBoundingClientRect()
          return [...document.querySelectorAll('#layer-chips .chip')].filter((c) => {
            const r = c.getBoundingClientRect()
            return r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom
          }).map((c) => c.dataset.cat)
        })
        ok(hidden.length === 0, 'the route badge covers no layer chip', hidden.join(', '))
      }
    }

    // Nothing on a published map may edit it. Surveying was a build-time tool.
    const editable = await page.evaluate(() => ({
      button: !!document.getElementById('tag-btn'),
      del: !!document.querySelector('#panel [data-tag-del]'),
      stored: localStorage.getItem('campusmap.tags.v1'),
    }))
    ok(!editable.button, 'no tag button on the published site')
    ok(!editable.del, 'no delete control on a place')
    ok(editable.stored === null, 'nothing written to tag storage')

    await page.keyboard.press('Escape')
  }

  // Without the permission already granted, the locate control must stay put:
  // auto-triggering here would throw a permission dialog at a first-time
  // visitor before they have even seen the map.
  const locateIdle = await page.evaluate(() => {
    const b = document.querySelector('.maplibregl-ctrl-geolocate')
    return b ? !b.className.includes('geolocate-active') &&
               !b.className.includes('geolocate-waiting') : 'missing'
  })
  ok(locateIdle === true, 'locate stays off when the permission is not granted', String(locateIdle))

  /* ── imagery ───────────────────────────────────────────────────────── */

  await page.keyboard.press('Escape')
  await page.click('#imagery-btn')
  const img = await page.evaluate(() => ({
    pressed: document.getElementById('imagery-btn').getAttribute('aria-pressed'),
    visible: window.__map?.getLayoutProperty('imagery', 'visibility'),
    // The flat ground has to get out of the way, or the photo is invisible
    // underneath it and the toggle looks broken.
    campusFill: window.__map?.getPaintProperty('campus', 'fill-opacity'),
    credit: !document.getElementById('imagery-credit').hidden,
    tint: window.__map?.getLayoutProperty('building-cat', 'visibility'),
  }))
  ok(img.pressed === 'true' && img.visible === 'visible', 'imagery layer switches on', img.visible)
  ok(img.campusFill === 0, 'ground fills step aside for the photo', `campus fill-opacity ${img.campusFill}`)
  ok(img.credit, 'imagery attribution appears with it')
  ok(img.tint === 'none', 'the building category tint is hidden over the photo', `visibility ${img.tint}`)

  if (SHOTS) {
    // Tiles are a network round trip; screenshotting before they land produces
    // a black rectangle that looks like a broken layer.
    // `isSourceLoaded` goes true during a lull with nothing in flight, well
    // before the visible tiles are actually decoded, so settle after it too.
    await page.waitForFunction(() => window.__map?.isSourceLoaded('imagery'), { timeout: 15_000 })
      .catch(() => {})
    await new Promise((r) => setTimeout(r, 2500))
    await page.screenshot({ path: join(ROOT, `.verify/${name}-imagery.png`) })
  }

  await page.click('#imagery-btn')
  const off = await page.evaluate(() => ({
    visible: window.__map?.getLayoutProperty('imagery', 'visibility'),
    campusFill: window.__map?.getPaintProperty('campus', 'fill-opacity'),
    credit: document.getElementById('imagery-credit').hidden,
    tint: window.__map?.getLayoutProperty('building-cat', 'visibility'),
  }))
  ok(off.visible === 'none' && off.campusFill === 1 && off.credit, 'and back off cleanly')
  ok(off.tint === 'visible', 'and the building tint comes back with the drawn map', `visibility ${off.tint}`)

  if (SHOTS) {
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(ROOT, `.verify/${name}.png`) })
  }

  // Late errors (style reload, tile decode) show up after interaction.
  ok(errors.length === 0, 'still no console errors after interaction', errors.slice(0, 3).join(' | '))
  await page.close()
}

/**
 * The other side of that: with the permission already granted, the locate
 * control should come up switched on rather than waiting to be found. Runs in
 * its own page, and last, because granting the permission moves the map — which
 * would quietly undermine every check above it.
 */
async function checkLocateOnByDefault() {
  console.log('\nlocation (permission already granted)')
  const ctx = browser.defaultBrowserContext()
  await ctx.overridePermissions(new URL(URL_).origin, ['geolocation'])

  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  // Stand in the middle of campus, so the fix is somewhere the map can show.
  await page.setGeolocation({
    latitude: campus.meta.center[1],
    longitude: campus.meta.center[0],
  })
  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 30_000 })
  await page.waitForFunction(
    () => document.getElementById('boot')?.classList.contains('gone'),
    { timeout: 20_000 },
  ).catch(() => {})

  const active = await page.waitForFunction(() => {
    const b = document.querySelector('.maplibregl-ctrl-geolocate')
    return !!b && /geolocate-(active|background)/.test(b.className)
  }, { timeout: 15_000 }).then(() => true).catch(() => false)
  const cls = await page.evaluate(() =>
    document.querySelector('.maplibregl-ctrl-geolocate')?.className ?? 'missing')
  ok(active, 'locate switches itself on when already permitted', cls)

  const dot = await page.waitForSelector('.maplibregl-user-location-dot', { timeout: 8000 })
    .then(() => true).catch(() => false)
  ok(dot, 'and the position marker is on the map')

  await ctx.clearPermissionOverrides()
  await page.close()
}

await check('desktop-dark', 1440, 900, 'dark')
await check('desktop-light', 1440, 900, 'light')
await check('mobile-dark', 402, 874, 'dark')
await checkLocateOnByDefault()

await browser.close()
await rm(PROFILE, { recursive: true, force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nbrowser verification passed\n')
process.exit(failures ? 1 : 0)
