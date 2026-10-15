/** What the law or a licence asks us to say. */
export const legal = {
  /** On the map, wherever the free OpenStreetMap tiles are drawn. */
  mapAttribution: '© OpenStreetMap contributors',
  /** On the map, wherever the free aerial photos are drawn. */
  imageryAttribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  /** On the map, wherever the MapTiler satellite photos are drawn (a MapTiler key is set). */
  maptilerImageryAttribution: 'Imagery © MapTiler',
  /** On the map, wherever the Google satellite photos are drawn (a Google key is set). */
  googleImageryAttribution: 'Imagery © Google',
  /** On a measured roof whose pitch is Google Solar's (Google's attribution rule: "Includes solar data from Google"). */
  solarPitchAttribution: 'Pitch from Google Solar (includes solar data from Google)',
  /** On a roof measured in 3D from Google Solar's height map. */
  solar3dAttribution: 'Roof measured in 3D from Google Solar (includes solar data from Google)',
  /** Shown when edges hidden by trees were placed from leaf-off lidar (roof3d.lidarEdges.applied). USGS data is public domain; credit is asked. */
  usgsLidarAttribution: 'Edges under trees placed from leaf-off lidar: USGS 3D Elevation Program (3DEP)',
  /** On a map roof whose outline is Google Solar's (no building footprint there). */
  solarOutlineAttribution: 'Outline from Google Solar (includes solar data from Google)',
  /** On the map, wherever building outlines are drawn. */
  footprintAttribution: 'Building outlines © Microsoft, ODbL',
  terms: 'Terms',
  privacy: 'Privacy',
} as const;
