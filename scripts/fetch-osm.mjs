// Re-runnable Overpass fetch. Writes data/raw/*.json.
//   node scripts/fetch-osm.mjs            # fetch anything missing
//   node scripts/fetch-osm.mjs --force    # refetch everything
//
// Data (c) OpenStreetMap contributors, ODbL.

import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'data/raw')

// IIEST Shibpur campus: OSM way 52097578 (amenity=university). The campus ring
// spans 22.5525–22.5579 N, 88.3006–88.3112 E; the bbox is padded past it so
// features that straddle the wall still come back whole.
export const CAMPUS_WAY = 52097578
export const BBOX = '22.5500,88.2975,22.5610,88.3145'

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

const QUERIES = {
  boundary: `[out:json][timeout:60];
way(${CAMPUS_WAY});
out geom tags;`,

  pois: `[out:json][timeout:180][bbox:${BBOX}];
(
  nwr["amenity"];
  nwr["shop"];
  nwr["building"]["name"];
  nwr["office"];
  nwr["leisure"];
  nwr["tourism"];
  nwr["healthcare"];
  nwr["emergency"];
  nwr["man_made"];
);
out center tags;`,

  buildings: `[out:json][timeout:180][bbox:${BBOX}];
(way["building"];);
out geom tags;`,

  highways: `[out:json][timeout:180][bbox:${BBOX}];
(way["highway"];);
out geom tags;`,

  land: `[out:json][timeout:180][bbox:${BBOX}];
(
  way["natural"];
  way["landuse"];
  way["waterway"];
  relation["natural"="water"];
  way["barrier"="wall"];
  way["barrier"="fence"];
);
out geom tags;`,
}

// Several Overpass mirrors rate-limit or outright reject the default Node
// user agent, and answer with an HTML scolding instead of JSON.
const UA = 'iiest-campus-map/0.1 (+https://github.com/iiest-map/iiest)'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function overpass(query, name) {
  let lastErr
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length]
    try {
      // A mirror under load can accept the connection and then never answer.
      // Without an explicit deadline that hangs the whole build, so give up and
      // try the next endpoint instead.
      const res = await fetch(endpoint, {
        method: 'POST',
        body: query,
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' },
        signal: AbortSignal.timeout(120_000),
      })
      const text = await res.text()
      // Overpass reports runtime errors as an HTML page with a 200 status.
      if (!text.startsWith('{')) throw new Error(`non-JSON from ${endpoint}: ${text.slice(0, 160)}`)
      const json = JSON.parse(text)
      if (!Array.isArray(json.elements)) throw new Error('missing elements[]')
      if (json.remark) throw new Error(`overpass remark: ${json.remark.slice(0, 120)}`)
      return json
    } catch (err) {
      lastErr = err
      const wait = 5000 * (attempt + 1)
      console.warn(`  ${name}: attempt ${attempt + 1} failed (${err.message.slice(0, 90)}), retrying in ${wait / 1000}s`)
      await sleep(wait)
    }
  }
  throw new Error(`${name}: all attempts failed — ${lastErr?.message}`)
}

async function main() {
  const force = process.argv.includes('--force')
  await mkdir(RAW, { recursive: true })

  for (const [name, query] of Object.entries(QUERIES)) {
    const path = join(RAW, `${name}.json`)
    if (!force && existsSync(path)) {
      const n = JSON.parse(await readFile(path, 'utf8')).elements.length
      console.log(`= ${name}: cached (${n} elements) — use --force to refetch`)
      continue
    }
    console.log(`> ${name}: fetching…`)
    const json = await overpass(query, name)
    await writeFile(path, JSON.stringify(json))
    console.log(`  ${name}: ${json.elements.length} elements`)
    await sleep(2000) // be polite to a free public API
  }
  console.log('\nDone. Run `npm run build:data` to regenerate public/data.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
