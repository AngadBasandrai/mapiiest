# IIEST Shibpur campus map

An installable, offline-capable map of IIEST Shibpur: the ground, the buildings,
the paths and the lakes drawn from OpenStreetMap, aerial imagery under it — and
**every place put on it by hand**.

No place on it is derived from an OpenStreetMap tag. OSM's coverage of this
campus is thin enough that auto-classifying it produces a sparse, half-wrong
map, so the 134 places here were surveyed instead — walked, named and recorded
against the aerial imagery — and the map is exactly as good as that survey.

```
npm install
npm run fetch      # Overpass -> data/raw  (cached; --force to refetch)
npm run dev        # build data, then Vite on :5180
npm test           # typecheck + rebuild + smoke test
```

## What it does

- **Search** over every place, ranked exact-key → prefix → fuzzy, in well under
  a millisecond. `Ctrl K` (`⌘K` on a Mac) or `/` anywhere, `↵` to open.
- **Directions** handed off to Google Maps: a place's panel links straight out
  to `maps.google.com` for that exact coordinate.
- **Aerial imagery** under the map, on a toggle — see what is actually there.
- **Layers** — one per category, appearing as you tag; a bottom sheet on phones.
- **Everything beyond the wall is dimmed**, so the campus reads as the subject
  rather than as a stripe through Howrah.
- **Light and dark**, following the system unless you say otherwise.
- **Deep links** — `?id=w517920623` focuses a place, `?q=library` opens search.
- **Installs, and works with no network** — see below.

## A webapp, not just a page

Install it from the browser's menu — "Add to Home screen" on Android and iOS,
the install icon in the address bar on desktop — and it opens in its own window
with no browser chrome, from a launcher icon, like anything else on the phone.

**It works with no network at all.** A service worker precaches the whole app on
first visit: the shell, the script, the stylesheet, `campus.json`, `geo.json` and
the font glyph atlases. That is the entire application — about 950 kB — so there
is nothing clever to decide about which parts to keep. Offline you get every
place, the search, the legend, the labels and the drawn map; the browser tab can
be cold-started with the radio off and it still opens.

Aerial tiles are cached separately, at runtime, capped at 400. They are
third-party and unbounded, so they must never be allowed to fill the origin's
storage quota — but the practical effect is that imagery you have already looked
at is available offline too.

When the tiles cannot be reached the map **falls back to the drawn version and
says so**, then restores imagery when the network returns. That path is driven by
the service worker rather than by `navigator.onLine`, for two reasons: the flag
is true on a captive portal and true when only that one host is blocked, and
MapLibre drops a failed raster tile silently — no error event, nothing in the
console — so the page has no way to notice on its own. The worker is the only
thing that sees the failed request, so it posts a message to the page.

### How it is built

`vite.config.ts` writes `sw.js` at build time with the precache list filled in
from what the build actually emitted. That is not tidiness: Vite hashes asset
filenames, so a hand-written list goes stale on the next build and the worker
serves last week's JavaScript forever. The cache name is a hash of the list, so
any change to any asset produces a new cache and the old one is dropped. No
Workbox — it is about fifty lines of cache handling.

`scripts/make-icons.mjs` draws the launcher icons (192, 512, maskable 512, and
an apple-touch 180) and they are committed. Generated rather than drawn so they
can be regenerated from the same accent colour the UI uses; a PNG is a zlib
stream in four chunks, which is less code than a dependency for it. Note the
browser tab still has no favicon — a launcher icon is a different job.

A new version does not swap itself in underneath you: when a fresh worker has
installed, the app offers a **Reload** button. Reloading a map without warning
loses wherever you had panned to.

## Origin association

`public/.well-known/web-app-origin-association` consents to the
`scope_extensions` claim that the sibling app at **iiest.wiki** makes over this
origin, so Chromium keeps navigations here inside that installed app rather than
dropping them into a browser tab. It is served at

    https://maps.iiest.wiki/.well-known/web-app-origin-association

with no extension and no redirect — both are part of the check — and
`web_app_identity` has to be `https://iiest.wiki/` character for character,
trailing slash included. A mismatch fails silently: no console warning, nothing
in devtools, the app just stops keeping links in-window. `npm test` asserts the
path, the JSON and that exact string for precisely that reason.

`public/.nojekyll` keeps the dot-directory alive on a branch deploy, where Jekyll
would strip it. This repo uploads an artifact instead, so Jekyll never runs, but
the file costs nothing and the failure it prevents is silent too.

## Imagery

Esri's World Imagery sits under the map, and it is **on by default**: OSM has 38
building footprints inside the wall against a campus full of them, so the drawn
map alone is mostly empty ground with 134 pins floating over it. On the
photograph every pin sits on the thing it names. The photo button in the top bar
switches it off and gives the drawn map back, tinted footprints and all.

Those tiles are the **only** request this site makes to anywhere else — and
because the layer is on by default, that request now happens on every load
rather than on demand. Everything else is served from this origin.

Labels get their own treatment over the photo: the theme's grey-on-pale pairing
is tuned for a flat surface of known lightness, and a photo is bright green,
white roof and dark shadow inside a single word, so both themes switch to white
on a dark halo while imagery is on.

Google's tiles are deliberately not an option. Serving them requires a Maps
Platform key with billing attached, and their terms do not permit using Google
imagery as a basemap under another provider's data, or caching it. Esri's layer
is free to use with attribution and needs no key, so it ships working out of the
box. If you specifically want Google, that means their JS SDK, your own API key,
and dropping the no-key/offline property of this build.

## Surveying (development only)

The places on this map were put there by hand, with a tagging tool built into
the app: turn on the pin button, tap the map, name what is there, pick a
category. Tags are kept in the browser's own storage, listed and deleted from
`My tags` in `Ctrl K`, and exported as JSON in exactly the
`data/curated/places.json` shape — so committing a survey is a paste and a
rebuild, at which point the build checks every row falls inside the campus
boundary.

**That tool is not part of the published site.** The survey is finished and
committed, so nothing on the live map can add or remove a place: the tag button,
the commands, the delete controls and the module behind them are all dropped
from a production build, guarded by `import.meta.env.DEV` in `src/main.ts`. The
guard is a dynamic `import()` rather than a flag around a static one, because a
static import would keep the module in the bundle no matter what — it touches
`localStorage` as it loads, so nothing can tree-shake it away.

`npm run dev` still has the whole tool, for the next survey. `npm run build`
has no trace of it, and the smoke and browser tests both assert that.

To add or correct a place now, edit `data/curated/places.json` directly — or run
the dev server, tag it, and paste the export in. Anything real and permanent is
better off in OpenStreetMap itself; every tag form links straight into the OSM
editor at that spot.

## How it is built

```
site.config.json   campus name, repo, the OSM way id of the boundary
data/raw/          Overpass responses, committed so a build needs no network
data/curated/      hand-surveyed places OSM does not carry yet
scripts/           fetch-osm, build-data, smoke, verify-browser
src/               map style, search engine, UI
public/font/       MapLibre glyph PBFs (Noto Sans, OFL)
```

`scripts/fetch-osm.mjs` pulls five Overpass queries into `data/raw/`.
`scripts/build-data.mjs` turns those plus `data/curated/` into the two files
the app loads:

| file | what |
| --- | --- |
| `campus.json` | places, categories, and the campus centre/bbox |
| `geo.json` | the entire basemap as GeoJSON — boundary, buildings, roads, paths, green, water |

The basemap really is drawn from that GeoJSON: MapLibre renders it directly, so
there is no tile server involved and the whole map is a few hundred kB. (The
optional aerial layer is the one exception — see **Imagery** above.)

Everything inside the campus boundary polygon is kept; everything outside is
dropped. Each tagged feature is classified into exactly one category by
`classify()` in `scripts/build-data.mjs` — first match wins.

## Categories

| | |
| --- | --- |
| Lecture halls · Depts & labs · Libraries | teaching and research |
| Halls & hostels · Staff quarters | where people live |
| Messes · Canteens · Shops · Vending | food and supplies |
| Landmarks · Lakes & ponds · Parks · Sports | how you navigate and what you do outdoors |
| Clubs & activities | extra-curricular — societies, cultural, NCC/NSS |
| Water coolers · Toilets · Laundry · Printing · ATMs & banks · Cycle parking | day-to-day |
| Health · Admin & help · Transport · Worship | services |
| Abandoned | derelict, disused, closed off |

Order matters in `classify()`: **Abandoned** is tested first, so a derelict
lecture hall does not send anyone looking for a lecture, and **Lakes** are
tested before greenery, or a pond inside a park polygon reads as parkland.

Categories with nothing in them show no layer chip, so the legend only ever
lists what the map actually has. All 25 remain available to the surveying tool
in a dev build, whether or not anything is in them yet.

The map's centre, opening frame and pan limits are **derived from the boundary**
at build time, not configured. Point `site.config.json` at another campus's OSM
way, refetch, and it frames itself.

## Why it starts empty

`site.config.json` has one switch:

```json
"places": { "fromOsm": false }
```

With it off — the default here — **no place is derived from an OSM tag**. The
build still draws every building footprint, road, path, lake and the boundary;
it just does not turn any of it into a named, searchable pin. Everything on the map comes from you.

Flip it to `true` and rerun `npm run build:data` and the classifier takes over
again: it finds 37 places from the current extract (17 halls of residence,
5 lakes, 4 academic buildings, 3 landmark towers, the Central Library, the
hospital, the bank, the guest house and two grounds). Nothing else needs to
change — the two modes share all the same code, and hand-added places sit
alongside OSM ones when both are on.

The reason to leave it off is that OSM simply does not know this campus:

- most academic departments (mapped as unnamed `building=university` footprints)
- canteens, messes, shops, printers
- water coolers, cycle stands, ATMs, toilets
- the footpath network — 33 roads but only **1 footway** inside the wall

Switch the aerial layer on and the scale of it is plain: whole rows of academic
blocks with no footprint drawn over them at all.

**The durable fix is to map it in OpenStreetMap**, which serves every other map
too, not just this one — start at
[way/52097578](https://www.openstreetmap.org/way/52097578) and it lands here on
the next `npm run fetch -- --force`. Tagging is the fast path in the meantime,
and the two are complementary: tag now so you can use the map today, push the
permanent things upstream as you go.

Hand-added places live in `data/curated/places.json` — either real coordinates
someone stood at, or an `anchor` naming an OSM feature to sit beside. Nothing in
there is a guess; a plausible invention on a map is worse than a gap. The
surveying tool writes exactly this format, so the loop was: imagery on → tag as
you walk → export → paste → rebuild.

## Not here

Faculty directories, mess menus, course timetables, notices, bus timings. Each
needs a real machine-readable source, and there is no honest way to ship them
without one.

## Tests

`npm test` typechecks, rebuilds the data and runs `scripts/smoke.mjs`, which
asserts that the basemap is intact, that every place is findable by its own
name, that the category vocabulary works even for categories nothing has landed
in yet, and that the MapLibre style validates in both themes.
It also checks that every element id the TypeScript reaches for exists in
`index.html` — that mismatch otherwise ships as a blank page.

Two things it deliberately checks the *absence* of: no place derived from an OSM
tag while `places.fromOsm` is off, and no tagging command in a production build.
It bundles the modules with `import.meta.env.DEV` defined as `false`, so what it
tests is the shape the public gets.

`npm run verify` drives the built site in headless Chrome at three viewports and
fails on any console error, failed request, or map that never painted. It also
loads the app, **cuts the network, cold-reloads, and requires the map to come up
with all 134 places, its labels and a working search** — the only check that can
tell a real offline app from a manifest and good intentions. It picks a
real place out of the current data, searches it, opens it, checks its Google
Maps link carries that place's own coordinates, toggles the imagery layer, and
confirms the page neither asks for your location nor offers any way to edit
anything. It needs a
server on `:5180` (`npx vite preview`) and a Chrome on `PATH` or `CHROME_PATH`;
`--url` points it at any other origin, including the live site.

## Deploying

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/pages.yml`. Live at **https://maps.grafitelab.in/**, with
`angadbasandrai.github.io/mapiiest/` redirecting to it.

The only thing that needs to be right is the **base path**: a project site is
served from `/<repo>/`, not the domain root, and every asset URL has to agree —
get it wrong and the page loads to a blank screen with a handful of 404s. The
workflow derives it from the repository name and passes it to Vite as
`BASE_PATH`, so nothing is hard-coded and `npm run dev` still runs at `/`.

To build a deployable copy locally:

```bash
BASE_PATH=/mapiiest/ npm run build          # macOS / Linux
$env:BASE_PATH='/mapiiest/'; npm run build  # PowerShell
```

On Git Bash for Windows, prefix with `MSYS_NO_PATHCONV=1` or the leading slash
is rewritten into a Windows path and the build comes out with nonsense URLs.

`public/_headers` is Netlify/Cloudflare syntax. GitHub Pages ignores it — Pages
cannot set response headers at all — so the caching and security headers there
only take effect if the site is also deployed to a host that reads that file.
Nothing depends on them.

### Custom domain

To serve this from `maps.grafitelab.in` instead. **Order matters** — the DNS
record has to exist before the repo switches over, or the site spends the gap
building for the wrong path.

1. **DNS first**, in Hostinger's hPanel (that zone runs on `dns-parking.com`
   nameservers): Domains → grafitelab.in → DNS / Nameservers → add

   | Type | Name | Points to | TTL |
   | --- | --- | --- | --- |
   | `CNAME` | `maps` | `angadbasandrai.github.io` | default |

   Note the target is the *user* domain with **no repo path** — a CNAME record
   cannot carry one. GitHub works out which repository to serve from the
   hostname it receives. Wait for `nslookup maps.grafitelab.in 8.8.8.8` to
   answer before going on; it is usually minutes.

2. **Then the repo**: create `public/CNAME` containing exactly
   `maps.grafitelab.in` — bare hostname, no scheme, no trailing slash — and set
   the same value in Settings → Pages → Custom domain. Commit and push.

3. **Base path** takes care of itself. A custom domain serves from its own root,
   so the repo name has to vanish from every asset URL; the workflow switches
   `BASE_PATH` to `/` the moment `public/CNAME` exists. Step 2 is the whole
   change.

4. **HTTPS**: GitHub issues a Let's Encrypt certificate once DNS resolves —
   usually minutes, occasionally up to a day. Then tick **Enforce HTTPS**.

`grafitelab.in` itself already points at GitHub Pages (185.199.108–111.153) for
a different repo. That is fine and does not conflict: one custom domain per
repository, and a subdomain is independent of the apex.

Verifying the domain at the account level (Settings → Pages → Verify domain, a
`TXT` record) stops anyone else pointing their Pages site at your subdomain
later — worth doing once, and it may already be done for this zone.

Once the custom domain is live, `angadbasandrai.github.io/mapiiest/` redirects
to it, so existing links keep working.

## Configuration

Everything campus-specific is in `site.config.json`: the display name, the
wordmark, the repo link, the OSM way id plus bbox used by the fetch, and the
`places.fromOsm` switch above.

## Credit

This started as a port of [ni5arga/iitk](https://github.com/ni5arga/iitk),
© 2026 ni5arga, MIT licensed — the same idea built for IIT Kanpur. The
opening-hours reader, the search scoring, the map style, most of the stylesheet
and the build pipeline all came from there, and its copyright notice is carried
in `LICENSE` accordingly. `LICENSE` lists file by file what was
inherited and what is new here.

## Licence

Code is MIT, © 2026 Angad Basandrai and © 2026 ni5arga — see `LICENSE`.

Map data from OpenStreetMap, and the surveyed places in `data/curated/`, are
under the [ODbL](https://www.openstreetmap.org/copyright). Aerial imagery is
served live from Esri and is not redistributed here. Font glyphs are Noto Sans
under the SIL Open Font License.
