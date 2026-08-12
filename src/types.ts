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
}

export interface Campus {
  meta: {
    name: string
    longName: string
    built: string
    center: [number, number]
    /** Bounding box of the campus boundary: [[west, south], [east, north]]. */
    bbox: [[number, number], [number, number]]
    attribution: string
    osmWay: number
    counts: Record<string, number>
  }
  categories: Record<string, Category>
  pois: Poi[]
  places?: { items: Poi[] }
}
