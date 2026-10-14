/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The MapTiler key, set when the app is built. It is never committed. Without one the map draws no basemap. */
  readonly VITE_MAPTILER_KEY?: string;
  /** `osm` draws the free OpenStreetMap tiles, `aerial` the Esri aerial photos, when there is no MapTiler key. */
  readonly VITE_MAP_TILES?: string;
  /** `aerial` draws the Esri aerial photos for the satellite view when there is no MapTiler key (the demo build sets it). */
  readonly VITE_MAP_IMAGERY?: string;
  /** The Google Maps Platform key: the roof view draws Google satellite photos (Map Tiles API) when it is set. */
  readonly VITE_GOOGLE_MAPS_KEY?: string;
}
