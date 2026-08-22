export interface Poi {
  id: string
  name: string
  cat: string
  lat: number
  lon: number
  src: 'osm' | 'seed'
  osm?: string
  kind?: string
  unnamed?: true
  /** Tagged in this browser rather than built from a source file. */
  user?: true
  /**
   * An outline for this place, as [lon, lat] pairs. Buildings are drawn as this
   * and nothing else; anything else keeps its dot and label and gets the area
   * underneath, with the whole of it clickable.
   */
  poly?: [number, number][]
  /** Overrides the category colour — how buildings are told apart. */
  color?: string
  alt?: string
  hours?: string
  wheelchair?: string
  phone?: string
  url?: string
  cuisine?: string
  capacity?: string
  covered?: string
  operator?: string
  desc?: string
  level?: string
  potable?: string
  near?: string
  price?: string
}

export interface Category {
  label: string
  color: string
  pin: boolean
  /** Sorts the picker in the editor. A key of Campus['groups']. */
  group?: string
  /** Drawn as its outline alone, with no dot and no label. */
  area?: true
}

export interface Campus {
  meta: {
    name: string
    longName: string
    built: string
    center: [number, number]
    /** Bounding box of the campus boundary: [[west, south], [east, north]]. */
    bbox: [[number, number], [number, number]]
    /**
     * The survey area — the campus plus site.config's `survey.radiusKm`. This
     * is how far out a place may be tagged, and what panning is fenced to. The
     * opening view is still `bbox`: the campus, not the district around it.
     */
    area: [[number, number], [number, number]]
    attribution: string
    osmWay: number
    counts: Record<string, number>
  }
  categories: Record<string, Category>
  /** Group key -> heading, for sorting the category picker in the editor. */
  groups?: Record<string, string>
  pois: Poi[]
  places?: { items: Poi[] }
}
