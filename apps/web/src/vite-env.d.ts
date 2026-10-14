/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The MapTiler key, set when the app is built. It is never committed. Without one the map draws no basemap. */
  readonly VITE_MAPTILER_KEY?: string;
  /** `osm` enables streets; `usgs` also enables historical public aerial imagery. Unset stays network-free. */
  readonly VITE_MAP_TILES?: string;
  /** Public demo presentation setting; never a credential. Set by the demo launcher. */
  readonly VITE_DEMO_GEOCODER?: string;
}
