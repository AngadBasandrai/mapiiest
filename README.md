# IIEST Shibpur campus map

An installable, offline-capable map of IIEST Shibpur **and the kilometre of
Howrah around it**: the ground, the buildings, the paths and the lakes drawn
from OpenStreetMap, aerial imagery under it — and **every place put on it by
hand**.

No place on it is derived from an OpenStreetMap tag. OSM's coverage here is thin
enough that auto-classifying it produces a sparse, half-wrong map, so the 152
places were surveyed instead — walked, named and recorded against the aerial
imagery — and the map is exactly as good as that survey.

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
- **Layers** — one per tag, appearing as you survey; a bottom sheet on phones.
- **A kilometre past the wall** — the chemist, the roll shop, the toto stand and
  the ghat are all outside it, so the survey is too.
- **Buildings are areas.** Departments, offices and labs sit inside one, so a
  building is drawn as a tinted outline with no dot and no label — the places
  inside it carry the names — and clicking anywhere in it opens it. Anything
  else can carry an outline too, and keeps its dot and label on top.
- **One dark ground.** There was a light theme and a toggle; it is gone. This is
  a map read over aerial photography, and the light twin cost a second set of
  every basemap colour, a dimmed derivation of all 39 category colours, and a
  full `setStyle` on every switch — for a mode nobody used.
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

### Surveying (development only)

The places on this map were put there by hand, with a tool built into the app:
turn on the pin button, then either

- **point** — tap a spot, or tap a place to edit it; or
- **area** — tap the corners, *finish*, then tap where the **marker** goes.

An outline and a marker are separate things. The outline is what a place
occupies; the marker is where its dot belongs — the door, the counter, the end
of the jetty — which is rarely the middle of the shape. An outline defaults to
the **Buildings** category, drawn as a tinted area with no dot and no label,
since the departments inside it carry the names; a scheme of eight muted tints
tells one building from the next.

Every place is editable, including the ones already committed: a local record
overrides the shipped one, deleting retires it, and **revert** puts it back. The
export is therefore the whole of `data/curated/places.json`, not a diff — paste
it over the file, rebuild, and the build checks every row and every outline
point falls inside the survey area.

**Tags** — the categories themselves — are editable the same way, from `Tags` in
`Ctrl K`. Add one, rename one, recolour one, or remove one you never file
anything under; a removal asks where its places should go first, because a place
in a category that no longer exists draws an unstyled dot in a layer with no
legend chip, which reads as the map losing data. That export is
`data/curated/categories.json`, and it carries only what differs from the
built-in set — so a later re-solve of the palette is not silently overridden by
a file that froze today's colours.

**None of that is part of the published site.** See **Surveying** below.

## How it is built

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

Esri's World Imagery sits under the map, and it is **on by default**: the drawn
map is ground, roads, water and the surveyed outlines, so on its own it is
mostly empty with the pins floating over it. On the photograph every pin sits on
the thing it names. The photo button in the top bar switches it off and gives
the drawn map back.

Outside the wall it is not a preference but the whole basemap: nothing new is
fetched from OSM for the survey ring, so the locality is photograph plus
whatever has been hand-surveyed onto it. Tag mode turns imagery on for that
reason — you cannot outline a building you cannot see.

Those tiles are the **only** request this site makes to anywhere else — and
because the layer is on by default, that request now happens on every load
rather than on demand. Everything else is served from this origin.

Labels get their own treatment over the photo: the grey-on-dark pairing is tuned
for a flat surface of known lightness, and a photo is bright green, white roof
and dark shadow inside a single word, so over imagery they switch to white
on a dark halo while imagery is on.

Google's tiles are deliberately not an option. Serving them requires a Maps
Platform key with billing attached, and their terms do not permit using Google
imagery as a basemap under another provider's data, or caching it. Esri's layer
is free to use with attribution and needs no key, so it ships working out of the
box. If you specifically want Google, that means their JS SDK, your own API key,
and dropping the no-key/offline property of this build.

## Surveying (development only)

Turn on the pin button, tap the map, name what is there, pick a tag. Records are
kept in the browser's own storage, listed from `Places` in `Ctrl K`, and
exported as JSON in exactly the `data/curated/places.json` shape — so committing
a survey is a paste and a rebuild. `Tags` does the same for the vocabulary,
exporting `data/curated/categories.json`. Nothing is uploaded; there is no
server.

**That tool is not part of the published site.** The button, the toolbar, the
commands, the edit controls, the tag manager and both modules behind them are
dropped from a production build, guarded by `import.meta.env.DEV` in
`src/main.ts`. The guard is a dynamic `import()` rather than a flag around a
static one, because a static import would keep the modules in the bundle no
matter what — they touch `localStorage` as they load, so nothing can tree-shake
them away. `npm run build` has no trace of it: one JS chunk, 832 kB against 858,
and none of its strings. The smoke and browser tests both assert that.

### It came off, went back, and came off again

Worth recording, because the middle step is where the map got most of what it
now has. The tool was first guarded on the reasoning that the campus survey was
finished and committed. It was not — not because the campus was incomplete, but
because the campus was the wrong boundary:

- **The wall is not the edge of the map.** A student's chemist, roll shop, toto
  stand, xerox counter and ghat are all on the other side of it. A map that
  stops at the boundary stops just short of most of what it is for.
- **The vocabulary was not finished either.** Five of the twenty-six categories
  never held a single place — `print`, `water`, `toilet`, `vending`,
  `transport` — while there was nowhere at all to file a sweet shop. A
  vocabulary you cannot change is one people work around, by filing things
  under whatever is closest, which quietly makes the map worse.

Reopening it produced 152 places from 137, and a tag set the survey reshaped as
it went: fourteen locality tags added, one (`locality`) retired for going unused
after all, two more (`gym`, `railwaystation`) added from inside the app, and six
renamed to what people actually call them. That done, it is guarded again — a
visitor to the published map has nothing to add with it and no way to keep what
they add, so shipping it only offers work that gets thrown away.

To add or correct a place now, run the dev server, tag it, and paste the export
back — or edit `data/curated/places.json` directly. Anything real and permanent
is better off in OpenStreetMap itself; every tag form links straight into the
OSM editor at that spot.

### The survey area

`site.config.json` carries the ring:

```json
"survey": { "radiusKm": 1 }
```

The build derives a box from the campus bbox plus that radius, ships it as
`campus.meta.area`, and validates every curated row and every outline point
against it instead of against the boundary polygon. The app fences panning to
it (plus generous slack — see `panBounds` in `src/config.ts` for why the slack
has to be generous). The **opening frame is still the campus**, not the ring:
fitting two and a half kilometres of Howrah to show a campus in the middle of it
helps nobody.

Nothing new is fetched from OpenStreetMap for the ring. The drawn basemap still
covers the campus and its immediate surroundings, which is what `data/raw/`
holds; outside that, the aerial imagery is the basemap, and it is on by default.
Everything in the locality is hand-surveyed on top of the photograph.

One row exceeds the ring on purpose and the build says so: the Botanical
Garden's outline runs about 0.9 km past the western edge, because the garden is
110 hectares and the ring is not. Its marker is inside, so it draws and searches
normally — the warning is the build noticing, not the survey being wrong.

## How it is built

```
site.config.json   campus name, repo, the OSM way id of the boundary
data/raw/          Overpass responses, committed so a build needs no network
data/curated/      hand-surveyed places, and any edits to the tag vocabulary
scripts/           fetch-osm, build-data, solve-palette, smoke, verify-browser
src/               map style, search engine, UI
public/font/       MapLibre glyph PBFs (Noto Sans, OFL)
```

`scripts/fetch-osm.mjs` pulls five Overpass queries into `data/raw/`.
`scripts/build-data.mjs` turns those plus `data/curated/` into the two files
the app loads:

| file | what |
| --- | --- |
| `campus.json` | places, categories and their groups, and the campus centre/bbox/area |
| `geo.json` | the entire basemap as GeoJSON — boundary, buildings, roads, paths, green, water |

The basemap really is drawn from that GeoJSON: MapLibre renders it directly, so
there is no tile server involved and the whole map is a few hundred kB. (The
optional aerial layer is the one exception — see **Imagery** above.)

Features from OpenStreetMap are kept if they fall inside the campus boundary
polygon. Hand-surveyed places are held to the wider **survey area** instead —
the campus plus `survey.radiusKm` — since the locality is the point of them.
Each tagged feature is classified into exactly one category by `classify()` in
`scripts/build-data.mjs` — first match wins.

## Tags

Forty-one, in five groups, of which **28 have anything in them**. The groups
exist only to sort the picker in the editor — forty-one in one flat dropdown is
a list nobody reads to the end of.

| group | tags |
| --- | --- |
| **On campus** | Buildings · Depts & labs · Lecture halls · Libraries · Admin & help · Clubs & activities · Halls & hostels · Staff quarters · Messes · Canteens · Sports · Gates · Abandoned |
| **Ground & landmarks** | Landmarks · Lakes & ponds · Parks & gardens · Worship · Hangouts |
| **Food & drink** | Restaurants · Street food & rolls · Tea stalls · Bakeries |
| **Shops & services** | Shops · Grocery · Printing and Xerox · Pharmacies · Health · Repairs & spares · Salons & barbers · Clothes & tailors · Laundry · Markets & bazaars · ATMs & banks · Schools & coaching · PG & rentals · Gyms |
| **Getting around** | Buses, autos & totos · Ferry ghats · Petrol pumps · Cycle parking · Railway Station |

Most of the second half of that list is new, and five went the other way —
`print`, `water`, `toilet`, `vending` and `transport` never held a single place
and are gone. The new ones are what a locality survey actually runs into: food
splits four ways because a student chooses between sitting down, standing with a
roll, nursing a cha and buying mishti; `shop` fans out because outside the wall
"shop" is most of what there is to map, and a kirana and a chemist being the
same purple dot helps nobody.

**Gyms** and **Railway Station** were added from inside the app mid-survey,
which is the tag manager doing its job — neither was foreseen when the built-in
set was written. **Localities & paras** went the other way: added for "meet me
at Kadamtala", never used, retired.

The built-in set lives in `CATEGORIES` in `scripts/build-data.mjs`;
`data/curated/categories.json` layers over it and is written by the editor's tag
manager, so changing the vocabulary has never meant editing code.

Order matters in `classify()`: **Abandoned** is tested first, so a derelict
lecture hall does not send anyone looking for a lecture; **Lakes** are tested
before greenery, or a pond inside a park polygon reads as parkland; and
**Pharmacies** are tested before **Health**, because at eleven at night the
chemist is the errand, not the hospital attached to it.

Tags with nothing in them show no layer chip, so the legend only ever lists what
the map actually has — which is what makes forty affordable. All forty are in
the editor's picker whether or not anything is in them yet.

### The palette

Thirty-nine of the forty draw a coloured dot, which is far past the ~8 a
categorical palette carries by hue alone. So it is not picked by eye:
`scripts/solve-palette.mjs` solves it as a maximin problem — spread the colours
as far apart as thirty-nine can be on the map's one dark ground — and only then
hands each tag a colour, matching the hue and saturation it wants where the
spread allows it. Separation is a property of the set, so the assignment step
cannot spend any of it.

The closest pair comes out at ΔE 11.0 (OKLab ×100). That is down from 12.9 at
twenty-six tags, and the drop is the honest price of fourteen more colours out
of the same finite space. `building` does not compete: it draws no dot, only a
fill at a fifth opacity that each building then overrides with its own tint, so
its khaki is pinned and the dots are solved *around* it.

Those values were solved when the app still had a light theme and scored the
worse of the two. The palette was deliberately **not** re-cut when the theme
went, and the reason is worth recording: solving for the dark ground alone only
reaches 11.2. Dimming by 0.62 compresses OKLab distances by about the same
factor as the ratio the two floors were set at, so the light-theme term had been
very nearly free all along. Re-solve when the tag set changes, not when the
ground does.

Assignment is semantic where the spread allows: lakes blue, parks green, health
crimson, the food group warm, quarters tan — and pharmacies the green cross an
Indian chemist actually uses, which frees the one vivid red for restaurants.
What no palette can do is survive colour blindness; no set of thirty-nine can.
Identity never rests on colour alone — pinned places carry their name on the
map, the legend chip names its tag, and clicking a dot opens its name.

The smoke test holds the floor, but only over the **solved** tags. A tag
coloured by hand from the tag manager is held to no colour rule at all: the form
warns when a pick lands close to one in use and lets it through, because a
survey stopping to argue about colour is worse than two dots that look alike —
and a red build over somebody's choice of swatch is worse than both. Those
clashes are reported by the smoke test instead of failing it. There is currently
one: `Bakeries` and `Railway Station` sit at ΔE 5.5, which is legible mostly
because the station is a single pinned place carrying its own name.

The map's centre and opening frame are **derived from the boundary** at build
time, not configured; the pan limits come from the survey area around it. Point
`site.config.json` at another campus's OSM way, refetch, and it frames itself.

## Why it starts empty

`site.config.json` has one switch:

```json
"places": { "fromOsm": false }
```

With it off — the default here — **no place is derived from an OSM tag**. The
build still draws every road, path, lake and the boundary;
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
name, that the tag vocabulary works even for tags nothing has landed in yet,
that the palette still meets its separation floor, that every place sits inside
the survey area and in a tag that exists, and that the MapLibre style validates
with every source it declares actually drawn by a layer. It also checks that
every element id the TypeScript reaches for exists in `index.html` — that
mismatch otherwise ships as a blank page.

It bundles the modules with `import.meta.env.DEV` defined as `false`, so what it
tests is the shape the public gets. Four things it deliberately checks the
*absence* of: no place derived from an OSM tag while `places.fromOsm` is off, no
OSM building layer in `geo.json`, no trace of the five retired tags, and no
editor command anywhere in the index.

`npm run verify` drives the built site in headless Chrome at two viewports and
fails on any console error, failed request, or map that never painted. It also
loads the app, **cuts the network, cold-reloads, and requires the map to come up
with every place, its labels and a working search** — the only check that can
tell a real offline app from a manifest and good intentions. It picks a real
place out of the current data, searches it, opens it, checks its Google Maps
link carries that place's own coordinates, toggles the imagery layer, and
confirms the page never asks for your location, carries no theme toggle, and
offers no way to edit anything.

It also proves the editor is not there: no tag button, no toolbar, no edit or
delete on a place, and nothing written to either storage key. The pass that
drove the editor end to end — tapping outside the wall, adding a tag, moving
places out of a removed one — went with the guard, and lives in this file's
history for the next survey to restore.

It needs a server on `:5180` (`npx vite preview`) and a Chrome on `PATH` or
`CHROME_PATH`; `--url` points it at any other origin, including the live site.

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
wordmark, the repo link, the OSM way id plus bbox used by the fetch, the
`places.fromOsm` switch above, and `survey.radiusKm` — how far past the wall a
place may be tagged.

The tag vocabulary is not in there. It lives in `CATEGORIES` in
`scripts/build-data.mjs` as a starting point, with `data/curated/categories.json`
layered over it — and that file is written by the app's own tag manager, so
changing the vocabulary does not mean editing code.

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
