import type { StyleSpecification } from 'maplibre-gl'
import type { Campus } from '../types'

/**
 * The whole basemap is drawn from our own GeoJSON — no tile server, no API key
 * and no external request. The campus is small enough that the entire extract
 * fits in a few hundred kB, so the map renders from one static fetch.
 *
 * Label glyphs are served from public/font too, rather than a demo CDN that can
 * 404 the fontstack and take every label on the map with it.
 */
const PALETTE = {
  dark: {
    bg: '#0b0d10',
    campus: '#10141a',
    green: '#121c15',
    water: '#0e2230',
    building: '#181d25',
    buildingEdge: '#232a35',
    named: '#1d2430',
    road: '#2a313d',
    roadCase: '#171b22',
    path: '#2e3743',
    steps: '#3a4250',
    wall: '#1c222b',
    boundary: '#28303c',
    label: '#9aa4b2',
    labelHalo: '#0b0d10',
    dotStroke: '#0b0d10',
    focus: '#58a6ff',
  },
  // Deliberately not a white map. The campus is a warm paper tone, buildings a
  // half-step darker, and roads the only near-white — so the built area reads
  // without any large field of pure white to stare into.
  light: {
    bg: '#dfe3e8',
    campus: '#f4f2ee',
    green: '#e2ebdc',
    water: '#cfe0ec',
    building: '#e6e3dd',
    buildingEdge: '#d3cfc7',
    named: '#ddd8cf',
    road: '#fdfdfc',
    roadCase: '#dcd8d1',
    path: '#fbfaf8',
    steps: '#b6b1a8',
    wall: '#e0dcd4',
    boundary: '#c2beb6',
    label: '#4a5058',
    labelHalo: '#f4f2ee',
    dotStroke: '#fdfdfc',
    focus: '#1f6feb',
  },
} as const

/** Must match a directory under public/font. */
export const FONT = 'Noto Sans Regular'

/**
 * Aerial imagery, on by default.
 *
 * This is the one thing on the page that fetches from somewhere else. It leads
 * because OpenStreetMap has too few building footprints here for the drawn map
 * to stand on its own — over the photograph every pin sits on the thing it
 * names, and the gap between what exists and what is mapped is plain.
 *
 * Google's tiles are deliberately not an option — their terms require an API
 * key with billing attached and do not permit serving their imagery underneath
 * another provider's data like this.
 */
export const IMAGERY = {
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  maxzoom: 19,
  credit: 'Esri, Maxar, Earthstar Geographics',
  creditUrl: 'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9',
}

export function buildStyle(
  geo: Record<string, GeoJSON.FeatureCollection>,
  campus: Campus,
  theme: 'light' | 'dark' = 'dark',
  base = '/',
): StyleSpecification {
  const C = PALETTE[theme]

  const src = (data: GeoJSON.FeatureCollection) => ({ type: 'geojson' as const, data })

  return {
    version: 8,
    glyphs: `${base}font/{fontstack}/{range}.pbf`,
    sources: {
      imagery: {
        type: 'raster',
        tiles: IMAGERY.tiles,
        tileSize: 256,
        maxzoom: IMAGERY.maxzoom,
        attribution: IMAGERY.credit,
      },
      boundary: src(geo.boundary!),
      green: src(geo.green!),
      water: src(geo.water!),
      waterway: src(geo.waterway!),
      wall: src(geo.wall!),
      roads: src(geo.roads!),
      paths: src(geo.paths!),
      buildings: src(geo.buildings!),
      pois: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },

      // Hidden until asked for; `applyImagery` flips this and thins out the
      // flat fills above it so the photograph shows through.
      {
        id: 'imagery', type: 'raster', source: 'imagery',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 1, 'raster-fade-duration': 200 },
      },

      { id: 'campus', type: 'fill', source: 'boundary', paint: { 'fill-color': C.campus, 'fill-opacity': 1 } },

      { id: 'green', type: 'fill', source: 'green', paint: { 'fill-color': C.green, 'fill-opacity': 1 } },
      { id: 'water', type: 'fill', source: 'water', paint: { 'fill-color': C.water, 'fill-opacity': 1 } },
      {
        id: 'waterway', type: 'line', source: 'waterway',
        paint: { 'line-color': C.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1, 18, 5] },
      },

      {
        id: 'campus-edge', type: 'line', source: 'boundary',
        paint: { 'line-color': C.boundary, 'line-width': 1.2, 'line-dasharray': [3, 2] },
      },
      {
        id: 'wall', type: 'line', source: 'wall',
        minzoom: 15,
        paint: { 'line-color': C.wall, 'line-width': 1 },
      },

      // Roads get a casing so junctions read cleanly at low zoom.
      {
        id: 'road-case', type: 'line', source: 'roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.roadCase,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 13, 2, 16, 7, 19, 22],
        },
      },
      {
        id: 'road', type: 'line', source: 'roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.road,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 13, 1, 16, 4.5, 19, 16],
        },
      },
      // Two layers rather than one: `line-dasharray` rejects data expressions,
      // so steps cannot be dashed by a `case` on the feature.
      {
        id: 'path', type: 'line', source: 'paths',
        minzoom: 14,
        filter: ['!=', ['get', 'hw'], 'steps'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.path,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 14, 0.6, 17, 2, 19, 5],
        },
      },
      {
        id: 'path-steps', type: 'line', source: 'paths',
        minzoom: 15,
        filter: ['==', ['get', 'hw'], 'steps'],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': C.steps,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 15, 1.5, 19, 6],
          'line-dasharray': [1, 1],
        },
      },

      {
        id: 'building', type: 'fill', source: 'buildings',
        paint: {
          'fill-color': ['case', ['!=', ['get', 'name'], ''], C.named, C.building],
          'fill-outline-color': C.buildingEdge,
          'fill-opacity': 1,
        },
      },
      {
        id: 'building-top', type: 'line', source: 'buildings',
        minzoom: 16,
        paint: { 'line-color': C.buildingEdge, 'line-width': 0.7 },
      },
      // Category tint for buildings that are themselves a POI.
      {
        id: 'building-cat', type: 'fill', source: 'buildings',
        filter: ['all', ['!=', ['get', 'cat'], ''], ['in', ['get', 'cat'], ['literal', []]]],
        paint: { 'fill-color': catColour(campus), 'fill-opacity': 0.16 },
      },

      {
        id: 'poi-dot', type: 'circle', source: 'pois',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 16, 4.5, 19, 7],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': C.dotStroke,
          'circle-stroke-width': 1.4,
        },
      },
      {
        id: 'poi-label', type: 'symbol', source: 'pois',
        // The default view sits just above z15, so a higher floor here means the
        // map opens with no labels at all.
        minzoom: 14.5,
        filter: ['==', ['get', 'pin'], true],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': [FONT],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 10, 19, 13.5],
          'text-offset': [0, 1.05],
          'text-anchor': 'top',
          'text-max-width': 8,
          'text-optional': true,
          'text-padding': 4,
          // Drop the least useful labels first when they collide.
          'symbol-sort-key': ['case', ['==', ['get', 'cat'], 'lecture'], 0,
                                      ['==', ['get', 'cat'], 'academic'], 1, 2],
        },
        paint: {
          'text-color': C.label,
          'text-halo-color': C.labelHalo,
          'text-halo-width': 1.4,
        },
      },
      {
        id: 'poi-focus', type: 'circle', source: 'pois',
        filter: ['==', ['get', 'focus'], true],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 9, 19, 18],
          'circle-color': 'transparent',
          'circle-stroke-color': C.focus,
          'circle-stroke-width': 1.6,
        },
      },
    ],
  }
}

/**
 * Show or hide the aerial layer, and thin the flat fills to match.
 *
 * Applied at runtime rather than baked into `buildStyle` so toggling costs one
 * frame instead of a full style reload — but it must be re-applied after every
 * `setStyle`, since that throws the whole thing away.
 */
export function applyImagery(map: maplibregl.Map, on: boolean, theme: 'light' | 'dark' = 'dark') {
  if (!map.getLayer('imagery')) return
  const C = PALETTE[theme]
  map.setLayoutProperty('imagery', 'visibility', on ? 'visible' : 'none')

  // Labels need their own treatment over a photograph. The theme's grey-on-pale
  // pairing is tuned for a flat ground of known lightness; a photo is bright
  // green, white roof and dark shadow within one word, and the light theme's
  // labels wash out over it. White on a dark halo is the cartographic answer
  // and reads on both themes, so over imagery both use it.
  if (map.getLayer('poi-label')) {
    map.setPaintProperty('poi-label', 'text-color', on ? '#ffffff' : C.label)
    map.setPaintProperty('poi-label', 'text-halo-color', on ? 'rgba(0,0,0,0.85)' : C.labelHalo)
    map.setPaintProperty('poi-label', 'text-halo-width', on ? 1.7 : 1.4)
  }

  // The category tint on building footprints is drawn from OSM building names,
  // which are not the surveyed list this map runs on — over a photograph it is
  // just coloured blotches on the wrong roofs. Keep it for the drawn map, where
  // it still helps a footprint read as "this is a hostel", and drop it here.
  if (map.getLayer('building-cat')) {
    map.setLayoutProperty('building-cat', 'visibility', on ? 'none' : 'visible')
  }

  // Over a photograph the drawn ground is a hindrance: what you want is the
  // real roofs, with our outlines on top showing what OSM already knows about.
  const opacity: [string, number, number][] = [
    // layer, normal, over imagery
    ['campus', 1, 0],
    ['green', 1, 0.15],
    ['water', 1, 0.2],
    ['building', 1, 0.22],
    ['road-case', 1, 0.3],
    ['road', 1, 0.45],
    ['path', 1, 0.7],
  ]
  for (const [id, off, dim] of opacity) {
    if (!map.getLayer(id)) continue
    const prop = map.getLayer(id)!.type === 'fill' ? 'fill-opacity' : 'line-opacity'
    map.setPaintProperty(id, prop, on ? dim : off)
  }
}

/** `match` expression mapping a category key to its colour. */
function catColour(campus: Campus): maplibregl.ExpressionSpecification {
  const pairs: (string | string[])[] = []
  for (const [k, v] of Object.entries(campus.categories)) pairs.push(k, v.color)
  return ['match', ['get', 'cat'], ...pairs, '#8b949e'] as unknown as maplibregl.ExpressionSpecification
}
