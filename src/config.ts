import site from '../site.config.json'
import type { Campus } from './types'

/**
 * Campus-specific strings. Everything the UI needs to name the place and link
 * back to the source lives here so that pointing this at another campus is one
 * file, not a grep.
 *
 * Coordinates deliberately do NOT live here — centre, framing and pan limits
 * are derived from the OSM boundary in scripts/build-data.mjs and arrive in
 * campus.meta, so they can never drift out of step with the actual data.
 */
export const SITE = site as {
  name: string
  longName: string
  brand: { head: string; tail: string }
  tagline: string
  repo: string
  osm: { campusWay: number; wikidata: string; bbox: string }
}

export const OSM_CAMPUS_URL = `https://www.openstreetmap.org/way/${SITE.osm.campusWay}`

type Box = [[number, number], [number, number]]

/**
 * Panning limits: the campus plus a margin of a third of its own span, so the
 * surroundings are reachable but the user cannot drift off into the empty grey
 * where this extract has no data at all.
 */
export function panBounds(campus: Campus): Box {
  const [[w, s], [e, n]] = campus.meta.bbox
  const padX = Math.max((e - w) / 3, 0.002)
  const padY = Math.max((n - s) / 3, 0.002)
  return [[w - padX, s - padY], [e + padX, n + padY]]
}

/** True when a browser-reported position is close enough to route from. */
export function onCampus(campus: Campus, lat: number, lon: number): boolean {
  const [[w, s], [e, n]] = panBounds(campus)
  return lat > s && lat < n && lon > w && lon < e
}
