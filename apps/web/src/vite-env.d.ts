/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The MapTiler key, set when the app is built. It is never committed. Without one the map draws no basemap. */
  readonly VITE_MAPTILER_KEY?: string;
  /** `osm` draws the free OpenStreetMap tiles when there is no MapTiler key. */
  readonly VITE_MAP_TILES?: string;
}
