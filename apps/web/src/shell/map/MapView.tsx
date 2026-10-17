import 'maplibre-gl/dist/maplibre-gl.css';
import { Button, type ColorScheme, tokens, useToast } from '@roofline/ui';
import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
import { useContext, useEffect, useRef, useState } from 'react';
import { UNSAFE_LocationContext } from 'react-router';
import { useMapArea, useMapPins } from '../../api/hooks.ts';
import type { PinsResult } from '../../api/types.ts';
import { mapCopy } from '../../copy/map.ts';
import { storm as stormCopy } from '../../copy/storm.ts';
import { footprintTilesInBox } from '@roofline/shared';
import { type BuildingAt, useBuildingAt, useEstimateFromFootprint, useEstimateFromPoint, useLoadBuildings } from '../../features/estimator/api.ts';
import { useStormLayer } from '../../features/storm/layerApi.ts';
import type { StormLayerResponse } from '../../features/storm/layerTypes.ts';
import { MapLegend } from './MapLegend.tsx';
import { bindMapInteractions } from './interactions.ts';
import { emptyMapData, installMapLayers, setPinsVisible, updateMapData, type MapData } from './layers.ts';
import { mapStyle, satelliteAvailable } from './mapStyle.ts';
import { PinCard } from './PinCard.tsx';
import { setRoofHighlight } from './roofLayer.ts';
import { RoofCard } from './RoofCard.tsx';
import { setSelectedPin } from './selectedLayer.ts';
import { applyStormData, setStormVisible } from './stormLayer.ts';
import { needsClientClustering, normalizeBbox, toFeatureCollections } from './pins.ts';
import type { Bbox } from '../../api/types.ts';
import type { Geometry } from 'geojson';
import type { MapEnv, MapMode, PickedPin, PinTarget } from './types.ts';
import { useColorScheme } from '../useColorScheme.ts';
import chrome from './MapChrome.module.css';
import styles from './MapView.module.css';

/** How much of the map's foot the legend and the attribution strip cover, in pixels: the legend stands 44px up and is two rows
 *  (84px) tall, and a cluster is a disc 40px across that must clear it. */
const MAP_FOOT = 160;

/**
 * The padding of the starting view: an even 40px, but the foot is kept free of data, so no pin or cluster ends up under the
 * legend or the attribution. A small map gives the foot at most a third of its height.
 */
function startPadding(height: number): { top: number; right: number; bottom: number; left: number } {
  return { top: 40, right: 40, bottom: Math.max(40, Math.min(MAP_FOOT, Math.round(height / 3))), left: 40 };
}

export type MapViewProps = {
  onOpen: (target: PinTarget) => void;
  /**
   * Opens the measure window for a measurement started from a roof. Given only for owner and office (the shell
   * decides); without it, a click on the map never looks for a roof.
   */
  onEstimate?: (measurementId: string) => void;
  /** Whether the Jobs layer starts on (the default) or off. The switch over the map still turns it either way. */
  pins?: boolean;
};

/** A roof picked on the map: the building under the click, and where the click was. */
type PickedRoof = BuildingAt & { lat: number; lng: number };

/** From this zoom the map is at building level: the outlines of the area in view start loading. */
const BUILDINGS_ZOOM = 15;
/** A roof lookup taking longer than this is loading a new area's outlines: say so. */
const SLOW_ROOF_MS = 1500;

const US_CENTER: [number, number] = [-96.5, 39.5];
const US_ZOOM = 3.5;
const PINS_DEBOUNCE_MS = 300;

/** The only place the two build-time map settings are read. It is called at use time, so tests can stub them. */
function readMapEnv(): MapEnv {
  return { maptilerKey: import.meta.env.VITE_MAPTILER_KEY, tiles: import.meta.env.VITE_MAP_TILES, imagery: import.meta.env.VITE_MAP_IMAGERY };
}

/** The company's colour as the page has it now (the brand slot is written at run time), for the ring around a picked pin. */
function brandColor(): string {
  if (typeof document === 'undefined') return tokens.brand;
  return getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || tokens.brand;
}

/** Creates the map, or answers null when it cannot start (MapLibre throws when the browser has no WebGL). */
function createMap(container: HTMLElement, scheme: ColorScheme): MapLibreMap | null {
  try {
    return new MapLibreMap({ container, style: mapStyle(readMapEnv(), 'streets', scheme), center: US_CENTER, zoom: US_ZOOM });
  } catch {
    return null;
  }
}

/** The ?focus= value, or null. Reads the router location when there is one (null outside a router, as in tests). */
function useFocusParam(): string | null {
  const location = useContext(UNSAFE_LocationContext);
  return location ? new URLSearchParams(location.location.search).get('focus') : null;
}

/** What the screen reader hears about the pins. Empty until the first answer arrives. */
function summarize(result: PinsResult | undefined): string {
  if (result === undefined) return '';
  return result.mode === 'points'
    ? mapCopy.summary(result.customers.length, result.jobs.length)
    : mapCopy.summaryClusters(result.total);
}

/**
 * The map: a MapLibre map that fills the panel it is put in, with customer and job pins and the hail layer. The
 * instance lives in a ref, not in state, so moving the map never re-renders the page. It follows the page's theme.
 */
export function MapView({ onOpen, onEstimate, pins: pinsAtStart = true }: MapViewProps) {
  const mapRef = useRef<MapLibreMap | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // False from the moment a style is swapped until its style.load arrives: the sources are gone until then.
  const styleReady = useRef(false);
  // The latest data for the layers. A style.load installs from here, so a swapped style gets today's pins.
  const dataRef = useRef<MapData>(emptyMapData());
  const appliedMode = useRef<MapMode>('streets');
  const [mode, setMode] = useState<MapMode>('streets');
  const scheme = useColorScheme();
  // The theme the map was last painted for. The first style is made for the theme at mount.
  const schemeRef = useRef<ColorScheme>(scheme);
  const appliedScheme = useRef<ColorScheme>(scheme);
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [hailOn, setHailOn] = useState(true);
  const hailOnRef = useRef(true);
  const hailToggled = useRef(false);
  // The Jobs switch: every pin and cluster, on or off
  const [pinsOn, setPinsOn] = useState(pinsAtStart);
  const pinsOnRef = useRef(pinsAtStart);
  const pinsToggled = useRef(false);
  const stormRef = useRef<StormLayerResponse | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<PickedPin | null>(null);
  // The picked pin as the map's style.load handler needs it (a swapped style loses the ring)
  const pickedRef = useRef<PickedPin | null>(null);
  const [roof, setRoof] = useState<PickedRoof | null>(null);
  const roofRef = useRef<PickedRoof | null>(null);
  const toast = useToast();
  const buildingAt = useBuildingAt();
  const fromFootprint = useEstimateFromFootprint();
  const fromPoint = useEstimateFromPoint();
  const loadBuildings = useLoadBuildings();
  const canEstimate = onEstimate !== undefined;
  // Footprint tiles already asked to load in this session
  const askedTiles = useRef(new Set<string>());
  const [roofSlow, setRoofSlow] = useState<number | null>(null);
  // The map's click listener is bound once; it reads the latest of these through refs.
  const roofClickRef = useRef<(lngLat: { lng: number; lat: number }) => void>(() => undefined);
  const area = useMapArea();
  const pins = useMapPins(bbox);
  const focus = useFocusParam();
  // The focus value already flown to, so a pins refresh does not fly again or reopen a closed card.
  const handledFocus = useRef<string | null>(null);
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
    const instance = createMap(container, schemeRef.current);
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
      installMapLayers(instance, dataRef.current, schemeRef.current);
      applyStormData(instance, stormRef.current);
      if (!hailOnRef.current) setStormVisible(instance, false);
      if (!pinsOnRef.current) setPinsVisible(instance, false);
      if (roofRef.current) setRoofHighlight(instance, roofRef.current.polygon as Geometry);
      if (pickedRef.current) setSelectedPin(instance, pickedRef.current.lngLat, brandColor());
    });
    instance.on('load', scheduleBbox);
    instance.on('moveend', scheduleBbox);
    // Any map error shows the banner. It never throws: the work on the page does not depend on the map.
    instance.on('error', () => setFailed(true));
    const unbind = bindMapInteractions(
      instance,
      (pin) => {
        roofRef.current = null;
        setRoof(null);
        setRoofHighlight(instance, null);
        setPicked(pin);
      },
      (lngLat) => roofClickRef.current(lngLat),
    );

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
    if (instance && area.data?.bounds) {
      instance.fitBounds(area.data.bounds, { padding: startPadding(instance.getContainer().clientHeight), maxZoom: 14 });
    }
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
    if (instance && styleReady.current) {
      updateMapData(instance, next);
      // A rebuilt pin group starts visible
      if (!pinsOnRef.current) setPinsVisible(instance, false);
    }
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

  // The Jobs switch. Nothing is touched on the first mount while the pins are on.
  useEffect(() => {
    pinsOnRef.current = pinsOn;
    if (pinsOn && !pinsToggled.current) return;
    pinsToggled.current = true;
    const instance = mapRef.current;
    if (instance && styleReady.current) setPinsVisible(instance, pinsOn);
  }, [pinsOn]);

  // The ring around the picked pin: the company's colour, 2px
  useEffect(() => {
    pickedRef.current = picked;
    const instance = mapRef.current;
    if (instance && styleReady.current) setSelectedPin(instance, picked === null ? null : picked.lngLat, brandColor());
  }, [picked]);
  // /?focus=<propertyId>: fly to that property's pin and open its card, once per distinct value.
  useEffect(() => {
    // Leaving ?focus= forgets the last one, so following the same address link again flies again.
    if (focus === null) {
      handledFocus.current = null;
      return;
    }
    if (handledFocus.current === focus) return;
    if (shownPins === undefined || shownPins.mode !== 'points') return;
    const job = shownPins.jobs.find((pin) => pin.propertyId === focus);
    const customer = job ? undefined : shownPins.customers.find((pin) => pin.propertyId === focus);
    const found = job ?? customer;
    if (!found) return;
    handledFocus.current = focus;
    mapRef.current?.easeTo({ center: [found.lng, found.lat], zoom: 16 });
    const next: PickedPin = job
      ? {
          kind: 'job',
          id: job.jobId,
          name: job.name,
          addressLine: job.addressLine,
          stage: job.stage,
          stageLabel: job.stageLabel,
          lngLat: [job.lng, job.lat],
        }
      : {
          kind: 'customer',
          id: found.customerId,
          name: found.name,
          addressLine: found.addressLine,
          stage: null,
          stageLabel: null,
          lngLat: [found.lng, found.lat],
        };
    // Not set synchronously: react-hooks/set-state-in-effect rejects a setState in the effect body.
    queueMicrotask(() => {
      setPicked(next);
    });
  }, [focus, shownPins]);

  // The satellite switch and the page's theme swap the style. The style.load handler then installs the layers again.
  useEffect(() => {
    schemeRef.current = scheme;
    const instance = mapRef.current;
    if (!instance || (appliedMode.current === mode && appliedScheme.current === scheme)) return;
    appliedMode.current = mode;
    appliedScheme.current = scheme;
    styleReady.current = false;
    instance.setStyle(mapStyle(readMapEnv(), mode, scheme), { diff: false });
  }, [mode, scheme]);

  // Zoomed in to building level (owner and office): the area's outlines start loading, so a roof click is quick
  const loadBuildingsRef = useRef(loadBuildings.mutate);
  useEffect(() => {
    loadBuildingsRef.current = loadBuildings.mutate;
  });
  useEffect(() => {
    if (!canEstimate || bbox === null || zoom === null || zoom < BUILDINGS_ZOOM) return;
    const tiles = footprintTilesInBox(bbox[0], bbox[1], bbox[2], bbox[3]);
    if (tiles === null || tiles.every((t) => askedTiles.current.has(t))) return;
    for (const t of tiles) askedTiles.current.add(t);
    loadBuildingsRef.current(bbox);
  }, [bbox, zoom, canEstimate]);

  // A roof lookup that takes a while is loading a new area: say so over the map
  const roofSince = buildingAt.isPending ? buildingAt.submittedAt : null;
  useEffect(() => {
    if (roofSince === null) return;
    const timer = setTimeout(() => setRoofSlow(roofSince), SLOW_ROOF_MS);
    return () => clearTimeout(timer);
  }, [roofSince]);
  const findingRoof = roofSince !== null && roofSlow === roofSince;

  // An empty-map click (owner and office): look up the building under it, highlight it and open its card.
  useEffect(() => {
    roofClickRef.current = (lngLat) => {
      if (!canEstimate) return;
      buildingAt.mutate(lngLat, {
        onSuccess: (building) => {
          const instance = mapRef.current;
          if (building === null) {
            roofRef.current = null;
            setRoof(null);
            if (instance && styleReady.current) setRoofHighlight(instance, null);
            toast.show(mapCopy.noBuilding);
            return;
          }
          const next: PickedRoof = { ...building, lat: lngLat.lat, lng: lngLat.lng };
          roofRef.current = next;
          setPicked(null);
          setRoof(next);
          if (instance && styleReady.current) setRoofHighlight(instance, building.polygon as Geometry);
        },
        onError: () => toast.show(mapCopy.roofFailed, 'error'),
      });
    };
  });

  const closeRoof = () => {
    roofRef.current = null;
    setRoof(null);
    const instance = mapRef.current;
    if (instance && styleReady.current) setRoofHighlight(instance, null);
  };

  const estimateRoof = () => {
    if (!roof || !onEstimate) return;
    const done = {
      onSuccess: ({ measurementId }: { measurementId: string }) => {
        closeRoof();
        onEstimate(measurementId);
      },
      onError: () => toast.show(mapCopy.roofFailed, 'error'),
    };
    // Google Solar's roof has no footprint: the estimate starts from the clicked point
    if (roof.footprintId === null) fromPoint.mutate({ lat: roof.lat, lng: roof.lng }, done);
    else fromFootprint.mutate({ footprintId: roof.footprintId, lat: roof.lat, lng: roof.lng }, done);
  };

  const satellite = satelliteAvailable(readMapEnv());
  // A map error, or a pins request that failed (the last good pins stay on the map meanwhile).
  const showBanner = failed || pins.isError;
  const swathCount = shownStorm?.swaths?.features?.length ?? 0;

  return (
    <div className={styles.root} data-mode={mode} data-card={picked !== null || (roof !== null && canEstimate) ? 'open' : undefined}>
      <div ref={containerRef} className={`${styles.map} ${chrome.chrome}`} role="region" aria-label={mapCopy.label} />
      <p className="visually-hidden" aria-live="polite">
        {summarize(shownPins)}
      </p>
      <div role="status" className={styles.status} data-state={showBanner ? 'error' : 'idle'}>
        {showBanner ? <p className={styles.banner}>{mapCopy.error}</p> : null}
        {hailOn && storm.data?.stale === true ? <p className={styles.banner}>{stormCopy.staleBanner}</p> : null}
        {findingRoof ? <p className={styles.banner}>{mapCopy.findingRoof}</p> : null}
      </div>
      <div role="group" aria-label={mapCopy.layersLabel} className={styles.controls}>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={pinsOn}
          onClick={() => {
            // Hidden pins leave no card behind
            if (pinsOn) setPicked(null);
            setPinsOn((current) => !current);
          }}
        >
          {mapCopy.jobsLayer}
        </Button>
        <Button size="sm" variant="ghost" aria-pressed={hailOn} onClick={() => setHailOn((current) => !current)}>
          {mapCopy.hailLayer}
        </Button>
        {satellite ? (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={mode === 'satellite'}
            data-state={mode === 'satellite' ? 'on' : 'off'}
            onClick={() => setMode((current) => (current === 'streets' ? 'satellite' : 'streets'))}
          >
            {mapCopy.satellite}
          </Button>
        ) : null}
      </div>
      <MapLegend hail={hailOn && swathCount > 0} pins={pinsOn} suppressed={picked !== null || (roof !== null && canEstimate)} />
      <p className="visually-hidden" aria-live="polite">
        {roof ? mapCopy.roofPicked : ''}
      </p>
      {roof && canEstimate ? (
        <div className={styles.card}>
          <RoofCard
            onEstimate={estimateRoof}
            busy={fromFootprint.isPending || fromPoint.isPending}
            onClose={closeRoof}
            fromSolar={roof.footprintId === null}
          />
        </div>
      ) : null}
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
