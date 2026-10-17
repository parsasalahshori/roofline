import { Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { doors } from '../../../copy/doors.ts';
import chrome from '../../../shell/map/MapChrome.module.css';
import { mapStyle } from '../../../shell/map/mapStyle.ts';
import { useColorScheme } from '../../../shell/useColorScheme.ts';
import type { DoorStop } from './types.ts';
import styles from './RouteMap.module.css';

export type RouteMapProps = {
  stops: DoorStop[];
  currentStopId: string | null;
  position: { lat: number; lng: number } | null;
};

type Box = [number, number, number, number];

function readMapEnv() {
  return { maptilerKey: import.meta.env.VITE_MAPTILER_KEY, tiles: import.meta.env.VITE_MAP_TILES };
}

/** The box around every stop, or null when there are none. */
function boundsOf(stops: DoorStop[]): Box | null {
  if (stops.length === 0) return null;
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const stop of stops) {
    box[0] = Math.min(box[0], stop.lng);
    box[1] = Math.min(box[1], stop.lat);
    box[2] = Math.max(box[2], stop.lng);
    box[3] = Math.max(box[3], stop.lat);
  }
  return box;
}

/**
 * The doors of one route on a map: a numbered marker per door in route order, the current door
 * emphasised, the done doors dimmed, and the rep's position as a blue dot. Without WebGL the map
 * is an empty box with the same label.
 */
export function RouteMap({ stops, currentStopId, position }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const dotRef = useRef<Marker | null>(null);
  const scheme = useColorScheme();
  // The theme the map was last painted for: its first style is made for the theme at mount
  const appliedScheme = useRef(scheme);

  // The map itself: made once, removed on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({ container, style: mapStyle(readMapEnv(), 'streets', appliedScheme.current), center: [-96, 39], zoom: 3 });
    } catch {
      return;
    }
    mapRef.current = map;
    return () => {
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // A theme switch repaints the base map; the door markers are page elements and stay where they are
  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedScheme.current === scheme) return;
    appliedScheme.current = scheme;
    map.setStyle(mapStyle(readMapEnv(), 'streets', scheme));
  }, [scheme]);

  // Fit the view to the doors when the route changes, not on every move of the rep.
  const box = boundsOf(stops);
  const west = box?.[0] ?? null;
  const south = box?.[1] ?? null;
  const east = box?.[2] ?? null;
  const north = box?.[3] ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || west === null || south === null || east === null || north === null) return;
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      // The attribution sits along the foot of the map: the doors stay clear of it (a door is a 31px disc)
      { padding: { top: 32, right: 32, bottom: 72, left: 32 }, maxZoom: 17, animate: false },
    );
  }, [west, south, east, north]);

  // The numbered door markers: rebuilt when the doors or the current door change, not when the rep moves.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers: Marker[] = [];
    stops.forEach((stop, index) => {
      const element = document.createElement('div');
      element.className = styles.marker;
      const state = stop.id === currentStopId ? 'current' : stop.outcome !== null ? 'done' : 'open';
      element.dataset.state = state;
      element.textContent = String(index + 1);
      markers.push(new Marker({ element }).setLngLat([stop.lng, stop.lat]).addTo(map));
    });
    return () => {
      for (const marker of markers) marker.remove();
    };
  }, [stops, currentStopId]);

  // The rep's dot: one marker that moves with the position.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!position) {
      dotRef.current?.remove();
      dotRef.current = null;
      return;
    }
    if (dotRef.current) {
      dotRef.current.setLngLat([position.lng, position.lat]);
      return;
    }
    const dot = document.createElement('div');
    dot.className = styles.you;
    dotRef.current = new Marker({ element: dot }).setLngLat([position.lng, position.lat]).addTo(map);
  }, [position]);

  useEffect(
    () => () => {
      dotRef.current?.remove();
      dotRef.current = null;
    },
    [],
  );

  return <div ref={containerRef} className={`${styles.map} ${chrome.chrome}`} role="region" aria-label={doors.routeMapLabel} />;
}
