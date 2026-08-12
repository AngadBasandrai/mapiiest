# IIEST Shibpur campus map

A map of IIEST Shibpur: the ground, the buildings, the paths and the lakes drawn
from OpenStreetMap, aerial imagery on a toggle, walking and cycling routes — and
**every place put on it by hand**.

It ships with no places at all. That is the point: OSM's coverage of this campus
is thin enough that auto-classifying its tags produces a sparse, half-wrong map,
so instead you tag what is actually there, from the ground or from the imagery,
and the map is exactly as good as the survey behind it.

```
npm install
npm run fetch      # Overpass -> data/raw  (cached; --force to refetch)
npm run dev        # build data, then Vite on :5180
npm test           # typecheck + rebuild + smoke test
```

## What it does

- **Tagging** — tap the map to put a place on it. Named, categorised, instantly
  searchable and routable; export the set as curated data when you are done.
- **Search** over every place you have added, ranked exact-key → prefix → fuzzy,
  in well under a millisecond. `⌘K` or `/` anywhere; `↵` opens, `tab` routes.
- **Routing** by A\* over the OSM path network, with walking and cycling costs
  baked per edge at build time, so the ETA falls straight out of the search.
- **Aerial imagery** under the map, on a toggle — see what is actually there.
- **Layers** — one per category, appearing as you tag; a bottom sheet on phones.
- **Light and dark**, following the system unless you say otherwise.
- **Deep links** — `?id=w517920623` focuses a place, `?q=library` opens search.

## Imagery

The photo button in the top bar drops Esri's World Imagery under the map and
thins the flat fills so it shows through. It is off by default and it is the
**only** request this site ever makes to anywhere else.

That layer is the same one OpenStreetMap's own iD editor uses for tracing, which
is precisely what it is for here: turn it on and the gap between what exists and
what is mapped is obvious at a glance.

Google's tiles are deliberately not an option. Serving them requires a Maps
Platform key with billing attached, and their terms do not permit using Google
imagery as a basemap under another provider's data, or caching it. Esri's layer
is free to use with attribution and needs no key, so it ships working out of the
box. If you specifically want Google, that means their JS SDK, your own API key,
and dropping the no-key/offline property of this build.

## Tagging what is missing

Turn on the pin button and tap anywhere. Name it, pick a category, save. Tagged
places behave like any other from that moment — drawn on the map, searchable,
routable, and their category gains a layer chip even if OSM had none of that
kind.

Removing one is the same gesture in reverse: open it on the map and hit
**Delete tag** on its panel, or delete it from the list in `My tags`. When the
last tag in a category goes, that category's chip goes with it. `Delete all my
tags` in `⌘K` clears the lot, after a confirmation.

Tags live in **this browser's localStorage and nowhere else**; there is no server
and nothing is uploaded. `My tags` in search (`⌘K`) exports the set as JSON in
exactly the `data/curated/places.json` shape, so committing them is a paste and
a rebuild — at which point the build checks each one falls inside the campus
boundary.

Every tag form also links straight into the OSM editor at that spot. For
anything real and permanent that is the better home: map it once there and it
arrives here on the next fetch, and in every other map that reads OSM.

## How it is built

```
site.config.json   campus name, repo, the OSM way id of the boundary
data/raw/          Overpass responses, committed so a build needs no network
data/curated/      hand-surveyed places OSM does not carry yet
scripts/           fetch-osm, build-data, smoke, verify-browser
src/               map style, router, search engine, UI
public/font/       MapLibre glyph PBFs (Noto Sans, OFL)
```

`scripts/fetch-osm.mjs` pulls five Overpass queries into `data/raw/`.
`scripts/build-data.mjs` turns those plus `data/curated/` into the three files
the app loads:

| file | what |
| --- | --- |
| `campus.json` | places, categories, and the campus centre/bbox |
| `geo.json` | the entire basemap as GeoJSON — boundary, buildings, roads, paths, green, water |
| `graph.json` | routing nodes and edges, costs in seconds per profile |

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

Categories with nothing in them show no layer chip, so on a fresh map the legend
is empty and fills in as you tag. Pick from the full list in the tag form
regardless — a category exists whether or not anything is in it yet.

The map's centre, opening frame and pan limits are **derived from the boundary**
at build time, not configured. Point `site.config.json` at another campus's OSM
way, refetch, and it frames itself.

## Why it starts empty

`site.config.json` has one switch:

```json
"places": { "fromOsm": false }
```

With it off — the default here — **no place is derived from an OSM tag**. The
build still draws every building footprint, road, path, lake and the boundary,
and still builds the routing graph; it just does not turn any of it into a
named, searchable pin. Everything on the map comes from you.

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
- the footpath network — 33 roads but only **1 footway** inside the wall, so a
  walking route currently follows the roads rather than the shortcut you would
  actually take

Switch the aerial layer on and the scale of it is plain: whole rows of academic
blocks with no footprint drawn over them at all.

**The durable fix is to map it in OpenStreetMap**, which serves every other map
too, not just this one — start at
[way/52097578](https://www.openstreetmap.org/way/52097578) and it lands here on
the next `npm run fetch -- --force`. Tagging is the fast path in the meantime,
and the two are complementary: tag now so you can use the map today, push the
permanent things upstream as you go.

Hand-added places live in `data/curated/places.json` — either real coordinates
someone stood at, or an `anchor` naming an OSM feature to sit beside. It ships
empty on purpose: a plausible guess on a map is worse than a gap. Tag mode
writes exactly this format, so the loop is: imagery on → tag as you walk →
export → paste → rebuild.

## Not here

Faculty directories, mess menus, course timetables, notices, bus timings. Each
needs a real machine-readable source, and there is no honest way to ship them
without one.

## Tests

`npm test` typechecks, rebuilds the data and runs `scripts/smoke.mjs`, which
asserts that the basemap and routing graph are intact, that every place is
findable by its own name, that the category vocabulary works for hand-tagged
places in categories no OSM data has ever landed in, that routing holds up on
both profiles with cycling never slower than walking, and that the MapLibre
style validates in both themes. It also checks that every element id the
TypeScript reaches for exists in `index.html` — that mismatch otherwise ships as
a blank page.

The suite adapts to the `places.fromOsm` switch: with it off it verifies nothing
leaks in from an OSM tag, and routes between corners of the path network instead
of between places, since there are none yet.

`npm run verify` drives the built site in headless Chrome at three viewports and
fails on any console error, failed request, or map that never painted. It also
runs the whole tagging loop for real — tag mode, tap, save, label, search, open,
route, delete — since on an empty map that is the only way a place exists at
all. It needs a server on `:5180` (`npx vite preview`) and a Chrome on `PATH` or
`CHROME_PATH`.

## Configuration

Everything campus-specific is in `site.config.json`: the display name, the
wordmark, the repo link, the OSM way id plus bbox used by the fetch, and the
`places.fromOsm` switch above. Set `repo` before publishing — it ships as a
placeholder.

## Credit

The idea, the shape of the app and much of its structure come from
[ni5arga/iitk](https://github.com/ni5arga/iitk), the same thing built for
IIT Kanpur.

## Licence

Code is MIT (see `LICENSE`). Map data is © OpenStreetMap contributors under the
[ODbL](https://www.openstreetmap.org/copyright). Font glyphs are Noto Sans under
the SIL Open Font License.
