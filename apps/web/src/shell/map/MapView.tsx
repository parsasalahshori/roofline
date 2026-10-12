import 'maplibre-gl/dist/maplibre-gl.css';
import { Button } from '@roofline/ui';
import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { useMapArea, useMapPins } from '../../api/hooks.ts';
import type { PinsResult } from '../../api/types.ts';
import { mapCopy } from '../../copy/map.ts';
import { storm as stormCopy } from '../../copy/storm.ts';
import { useStormLayer } from '../../features/storm/layerApi.ts';
import type { StormLayerResponse } from '../../features/storm/layerTypes.ts';
import { HailLegend } from './HailLegend.tsx';
import { bindMapInteractions } from './interactions.ts';
import { emptyMapData, installMapLayers, updateMapData, type MapData } from './layers.ts';
import { mapStyle, satelliteAvailable } from './mapStyle.ts';
import { PinCard } from './PinCard.tsx';
import { applyStormData, setStormVisible } from './stormLayer.ts';
import { needsClientClustering, normalizeBbox, toFeatureCollections } from './pins.ts';
import type { Bbox } from '../../api/types.ts';
import type { MapEnv, MapMode, PickedPin, PinTarget } from './types.ts';
import styles from './MapView.module.css';

export type MapViewProps = { onOpen: (target: PinTarget) => void };

const US_CENTER: [number, number] = [-96.5, 39.5];
const US_ZOOM = 3.5;
const PINS_DEBOUNCE_MS = 300;

/** The only place the two build-time map settings are read. It is called at use time, so tests can stub them. */
function readMapEnv(): MapEnv {
  return { maptilerKey: import.meta.env.VITE_MAPTILER_KEY, tiles: import.meta.env.VITE_MAP_TILES };
}

/** Creates the map, or answers null when it cannot start (MapLibre throws when the browser has no WebGL). */
function createMap(container: HTMLElement): MapLibreMap | null {
  try {
    return new MapLibreMap({ container, style: mapStyle(readMapEnv(), 'streets'), center: US_CENTER, zoom: US_ZOOM });
  } catch {
    return null;
  }
}

/** What the screen reader hears about the pins. Empty until the first answer arrives. */
function summarize(result: PinsResult | undefined): string {
  if (result === undefined) return '';
  return result.mode === 'points'
    ? mapCopy.summary(result.customers.length, result.jobs.length)
    : mapCopy.summaryClusters(result.total);
}

/**
 * The map home: a full-screen MapLibre map at the bottom layer, with customer and job pins. The
 * instance lives in a ref, not in state, so moving the map never re-renders the page.
 */
export function MapView({ onOpen }: MapViewProps) {
  const mapRef = useRef<MapLibreMap | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // False from the moment a style is swapped until its style.load arrives: the sources are gone until then.
  const styleReady = useRef(false);
  // The latest data for the layers. A style.load installs from here, so a swapped style gets today's pins.
  const dataRef = useRef<MapData>(emptyMapData());
  const appliedMode = useRef<MapMode>('streets');
  const [mode, setMode] = useState<MapMode>('streets');
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [hailOn, setHailOn] = useState(true);
  const hailOnRef = useRef(true);
  const hailToggled = useRef(false);
  const stormRef = useRef<StormLayerResponse | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<PickedPin | null>(null);
  const area = useMapArea();
  const pins = useMapPins(bbox);
  // The last pins answer that arrived. A failed request leaves it alone, so the pins stay on the map.
  const [shownPins, setShownPins] = useState<PinsResult | undefined>(undefined);
  if (pins.data !== undefined && pins.data !== shownPins) setShownPins(pins.data);
  const storm = useStormLayer(bbox, zoom, hailOn);
  // The last storm answer that arrived; an error or an unexpected answer leaves it alone.
  const [shownStorm, setShownStorm] = useState<StormLayerResponse | undefined>(undefined);
  if (storm.data !== undefined && storm.data !== shownStorm) setShownStorm(storm.data);

  // Create the map once, and remove it when the page goes away.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const instance = createMap(container);
    if (!instance) {
      // Not set synchronously: react-hooks/set-state-in-effect rejects a setState in the effect body.
      queueMicrotask(() => {
        setFailed(true);
      });
      return;
    }
    instance.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    mapRef.current = instance;
    styleReady.current = false;
    appliedMode.current = 'streets';

    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleBbox = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = normalizeBbox(instance.getBounds());
        setZoom(instance.getZoom());
        setBbox((previous) =>
          previous !== null && previous.every((value, index) => value === next[index]) ? previous : next,
        );
      }, PINS_DEBOUNCE_MS);
    };

    instance.on('style.load', () => {
      styleReady.current = true;
      installMapLayers(instance, dataRef.current);
      applyStormData(instance, stormRef.current);
      if (!hailOnRef.current) setStormVisible(instance, false);
    });
    instance.on('load', scheduleBbox);
    instance.on('moveend', scheduleBbox);
    // Any map error shows the banner. It never throws: the work on the page does not depend on the map.
    instance.on('error', () => setFailed(true));
    const unbind = bindMapInteractions(instance, setPicked);

    return () => {
      clearTimeout(timer);
      unbind();
      instance.remove();
      styleReady.current = false;
      if (mapRef.current === instance) mapRef.current = null;
    };
  }, []);

  // The starting view: the service area, or the US view that the map was created with.
  useEffect(() => {
    const instance = mapRef.current;
    if (instance && area.data?.bounds) instance.fitBounds(area.data.bounds, { padding: 40, maxZoom: 14 });
  }, [area.data]);

  // Feed the layers from the last good answer, so a failed pins request leaves the pins on the map.
  useEffect(() => {
    const next: MapData = {
      ...emptyMapData(),
      serviceArea: area.data?.serviceArea ?? null,
      ...(shownPins ? toFeatureCollections(shownPins) : {}),
      clustering: needsClientClustering(shownPins),
    };
    dataRef.current = next;
    const instance = mapRef.current;
    if (instance && styleReady.current) updateMapData(instance, next);
  }, [area.data, shownPins]);

  // Feed the storm layer from the last good answer.
  useEffect(() => {
    stormRef.current = shownStorm;
    const instance = mapRef.current;
    if (instance && styleReady.current) {
      applyStormData(instance, shownStorm);
      if (!hailOnRef.current) setStormVisible(instance, false);
    }
  }, [shownStorm]);

  // The hail switch. Nothing is touched on the first mount while the layer is on.
  useEffect(() => {
    hailOnRef.current = hailOn;
    if (hailOn && !hailToggled.current) return;
    hailToggled.current = true;
    const instance = mapRef.current;
    if (instance && styleReady.current) setStormVisible(instance, hailOn);
  }, [hailOn]);

  // The satellite switch swaps the style. The style.load handler then installs the layers again.
  useEffect(() => {
    const instance = mapRef.current;
    if (!instance || appliedMode.current === mode) return;
    appliedMode.current = mode;
    styleReady.current = false;
    instance.setStyle(mapStyle(readMapEnv(), mode), { diff: false });
  }, [mode]);

  const satellite = satelliteAvailable(readMapEnv());
  // A map error, or a pins request that failed (the last good pins stay on the map meanwhile).
  const showBanner = failed || pins.isError;
  const swathCount = shownStorm?.swaths?.features?.length ?? 0;

  return (
    <div className={styles.root} data-mode={mode}>
      <div ref={containerRef} className={styles.map} role="region" aria-label={mapCopy.label} />
      <p className="visually-hidden" aria-live="polite">
        {summarize(shownPins)}
      </p>
      <div role="status" className={styles.status} data-state={showBanner ? 'error' : 'idle'}>
        {showBanner ? <p className={styles.banner}>{mapCopy.error}</p> : null}
        {hailOn && storm.data?.stale === true ? <p className={styles.banner}>{stormCopy.staleBanner}</p> : null}
      </div>
      <div className={styles.controls}>
        {satellite ? (
          <Button
            variant="ghost"
            aria-pressed={mode === 'satellite'}
            data-state={mode === 'satellite' ? 'on' : 'off'}
            onClick={() => setMode((current) => (current === 'streets' ? 'satellite' : 'streets'))}
          >
            {mapCopy.satellite}
          </Button>
        ) : null}
        <Button variant="ghost" aria-pressed={hailOn} onClick={() => setHailOn((current) => !current)}>
          {mapCopy.hailLayer}
        </Button>
      </div>
      <HailLegend visible={hailOn && swathCount > 0} />
      {picked ? (
        <div className={styles.card}>
          <PinCard
            pin={picked}
            onClose={() => setPicked(null)}
            onOpen={(target) => {
              setPicked(null);
              onOpen(target);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
