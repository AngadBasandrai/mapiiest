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

/** Roughly how far five kilometres is, in degrees, at this campus. */
const KM = 1 / 111.32
const SLACK_KM = 5

/**
 * Panning limits: the campus plus five kilometres in every direction.
 *
 * The slack is deliberately generous, and the previous value — a third of the
 * campus's own span — was the cause of a real bug worth recording. MapLibre
 * treats `maxBounds` as a hard container: if the viewport at the framing zoom
 * would not *fit inside* the box, it silently zooms in until it does, and
 * whatever `fitBounds` asked for is discarded.
 *
 * This campus is a band 1.1 km wide and 0.6 km tall. A third of that is a box
 * about a kilometre high — far shorter than a portrait phone viewport at the
 * zoom that frames the campus, so on every phone the map opened at z15.8
 * instead of z14.4: the east and west ends cropped off, two kilometres of
 * latitude on screen, and the campus a stripe through the middle of Howrah.
 * Nothing in the framing code was wrong, and none of it had any effect.
 *
 * Five kilometres cannot bind on any plausible viewport, so the fence still
 * stops you panning to another city while the framing decides the view.
 */
export function panBounds(campus: Campus): Box {
  const [[w, s], [e, n]] = campus.meta.bbox
  const padY = SLACK_KM * KM
  // Longitude degrees are shorter than latitude ones away from the equator.
  const padX = padY / Math.max(Math.cos(((s + n) / 2) * Math.PI / 180), 0.2)
  return [[w - padX, s - padY], [e + padX, n + padY]]
}
