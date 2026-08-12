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

// A query the current data can always answer. Places may be absent entirely —
// this map is built to start empty and be filled in by hand — but the command
// palette always has its own commands in it.
const campus = JSON.parse(await readFile(join(ROOT, 'public/data/campus.json'), 'utf8'))
const QUERY = 'satellite'
const TAG_NAME = 'Verify Test Place'
// Tag into a category nothing currently lives in, so the run can prove a layer
// chip appears with the first place in it and disappears with the last. Falls
// back to any category when the map is already full, dropping those two checks.
const TAG_CAT = Object.keys(campus.categories)
  .find((c) => !campus.pois.some((p) => p.cat === c))
const TAG_CAT_IS_NEW = !!TAG_CAT

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

  ok(await page.$('#foot a') !== null, 'source link present in footer')

  // In dock mode the chips and the footer share one stack and must not
  // collide. In sheet mode the legend is an overlay that covers them on
  // purpose, so the check does not apply.
  if (!sheetMode) {
    const overlap = await page.evaluate(() => {
      const l = document.getElementById('layers')?.getBoundingClientRect()
      const f = document.getElementById('foot')?.getBoundingClientRect()
      if (!l || !f) return 'missing'
      return l.bottom > f.top + 1 ? `layers.bottom=${l.bottom.toFixed(0)} > foot.top=${f.top.toFixed(0)}` : ''
    })
    ok(overlap === '', 'layer chips do not overlap the footer', overlap)
  }

  // Open the palette and run a query the way a user would.
  await page.keyboard.down('Meta'); await page.keyboard.press('KeyK'); await page.keyboard.up('Meta')
  const paletteOpen = await page.waitForFunction(
    () => document.getElementById('palette') && !document.getElementById('palette').hidden,
    { timeout: 4000 },
  ).then(() => true).catch(() => false)
  ok(paletteOpen, 'palette opens on ⌘K')

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
      await page.keyboard.down('Meta'); await page.keyboard.press('KeyK'); await page.keyboard.up('Meta')
      await page.waitForFunction(() => !document.getElementById('palette').hidden, { timeout: 3000 })
      await page.type('#palette-input', QUERY, { delay: 8 })
      await page.waitForFunction(() => document.querySelectorAll('#palette-results .row').length > 0,
        { timeout: 4000 }).catch(() => {})
    }

    // Opening a result is exercised further down against a real place — this
    // query returns commands, and running one would fight the imagery check.
    await page.keyboard.press('Escape')
  }

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
  }))
  ok(img.pressed === 'true' && img.visible === 'visible', 'imagery layer switches on', img.visible)
  ok(img.campusFill === 0, 'ground fills step aside for the photo', `campus fill-opacity ${img.campusFill}`)
  ok(img.credit, 'imagery attribution appears with it')

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
  }))
  ok(off.visible === 'none' && off.campusFill === 1 && off.credit, 'and back off cleanly')

  /* ── tagging ───────────────────────────────────────────────────────── */

  await page.click('#tag-btn')
  const tagOn = await page.evaluate(() =>
    document.getElementById('tag-btn').getAttribute('aria-pressed') === 'true' &&
    document.body.classList.contains('tagging'))
  ok(tagOn, 'tag mode switches on')

  // Tap the middle of the map, which is inside the campus at the default frame.
  await page.mouse.click(Math.round(width / 2), Math.round(height / 2))
  const formUp = await page.waitForSelector('#tag-name', { timeout: 4000 })
    .then(() => true).catch(() => false)
  ok(formUp, 'tapping the map opens the tag form')

  if (formUp) {
    await page.type('#tag-name', TAG_NAME, { delay: 8 })
    await page.select('#tag-cat', TAG_CAT ?? 'canteen')
    await page.click('[data-tag-save]')

    const saved = await page.waitForFunction(
      () => document.querySelectorAll('#panel .tag-row').length > 0,
      { timeout: 4000 },
    ).then(() => true).catch(() => false)
    ok(saved, 'saving lists the tag')

    const after = await page.evaluate(() => ({
      count: document.querySelector('#tag-btn .n')?.textContent,
      stored: JSON.parse(localStorage.getItem('campusmap.tags.v1') ?? '[]').length,
      // A tag in a category the OSM extract has none of must bring that layer
      // into being, or the pin is saved and then never drawn.
      chips: [...document.querySelectorAll('#layer-chips .chip')].map((c) => c.dataset.cat),
      tagMode: document.body.classList.contains('tagging'),
    }))
    ok(after.count === '1' && after.stored === 1, 'tag persists and is counted', `badge ${after.count}`)
    if (TAG_CAT_IS_NEW) {
      ok(after.chips.includes(TAG_CAT), `a new category (${TAG_CAT}) gains its own layer chip`)
    }
    ok(!after.tagMode, 'tag mode switches itself off after a save')

    // Labels are the thing a broken glyph URL silently kills, and on a map that
    // starts empty a tagged place is the first label there is to draw.
    // Poll rather than waiting for `idle`: tag mode switches the aerial layer
    // on, and a map with raster tiles in flight may not go idle for a while.
    const labelled = await page.waitForFunction(
      () => window.__map?.queryRenderedFeatures({ layers: ['poi-label'] }).length > 0,
      { timeout: 15_000 },
    ).then(() => true).catch(() => false)
    const labels = await page.evaluate(() =>
      window.__map.queryRenderedFeatures({ layers: ['poi-label'] }).map((f) => f.properties.name))
    ok(labelled, `the tagged place draws a map label (${labels.length})`,
       labelled ? labels[0] : 'glyphs failed or minzoom too high')

    // And it must be findable like anything else on the map.
    await page.keyboard.down('Meta'); await page.keyboard.press('KeyK'); await page.keyboard.up('Meta')
    await page.waitForFunction(() => !document.getElementById('palette').hidden, { timeout: 3000 })
    await page.type('#palette-input', 'Verify Test', { delay: 8 })
    await page.waitForFunction(() => document.querySelectorAll('#palette-results .row').length > 0,
      { timeout: 4000 }).catch(() => {})
    const found = await page.$$eval('#palette-results .row-title', (r) => r.map((x) => x.textContent))
    ok(found.some((t) => new RegExp(TAG_NAME).test(t ?? '')), 'a tagged place is searchable at once',
       found[0] ?? 'nothing')

    // Open it from search: the panel, the route and the delete all hang off a
    // real place, which on this map only exists once you have made one.
    await page.keyboard.press('Enter')
    const panelUp = await page.waitForFunction(
      () => document.getElementById('panel') && !document.getElementById('panel').hidden,
      { timeout: 4000 },
    ).then(() => true).catch(() => false)
    ok(panelUp, 'selecting it opens the panel')

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
      ok(routed && eta !== '', 'routing to a tagged place draws a path with an ETA', eta)
    }

    const hasDelete = await page.$('#panel [data-tag-del]') !== null
    ok(hasDelete, 'a tagged place offers Delete on its own panel')

    if (hasDelete) {
      await page.click('#panel [data-tag-del]')
      const gone = await page.evaluate(() => ({
        stored: JSON.parse(localStorage.getItem('campusmap.tags.v1') ?? '[]').length,
        badge: document.querySelector('#tag-btn .n')?.textContent,
        // The layer it brought into being goes with it.
        chips: [...document.querySelectorAll('#layer-chips .chip')].map((c) => c.dataset.cat),
        pins: window.__map?.getSource('pois')?._data?.features
          ?.filter((f) => /Verify Test/.test(f.properties.name)).length,
      }))
      ok(gone.stored === 0 && gone.badge === '', 'deleting removes it everywhere', `badge "${gone.badge}"`)
      if (TAG_CAT_IS_NEW) {
        ok(!gone.chips.includes(TAG_CAT), 'and takes its now-empty layer chip with it')
      }
      ok(gone.pins === 0, 'and the pin leaves the map')
    }

    await page.evaluate(() => localStorage.removeItem('campusmap.tags.v1'))
  }

  if (SHOTS) {
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(ROOT, `.verify/${name}.png`) })
  }

  // Late errors (style reload, tile decode) show up after interaction.
  ok(errors.length === 0, 'still no console errors after interaction', errors.slice(0, 3).join(' | '))
  await page.close()
}

await check('desktop-dark', 1440, 900, 'dark')
await check('desktop-light', 1440, 900, 'light')
await check('mobile-dark', 402, 874, 'dark')

await browser.close()
await rm(PROFILE, { recursive: true, force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nbrowser verification passed\n')
process.exit(failures ? 1 : 0)
