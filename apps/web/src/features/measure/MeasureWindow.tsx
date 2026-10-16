import 'maplibre-gl/dist/maplibre-gl.css';
import { Banner, Button, Checkbox, EmptyState, Field } from '@roofline/ui';
import { instantEstimate, measureRoof, quoteFacets, type ProposalView, type Ring } from '@roofline/shared';
import { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { paidReports } from '../../copy/billing.ts';
import { liftMeasure, liftMeasureSteps, liftProposal } from '../../copy/liftMeasure.ts';
import { measure } from '../../copy/measure.ts';
import { makeFailureMessage, useBuildProposal, useEstimateFromFootprint, useEstimateFromPoint, useSendProposal } from '../estimator/api.ts';
import type { MapEnv } from '../../shell/map/types.ts';
import type { NewCustomerInput } from '../estimator/types.ts';
import { useExactReport, useMeasurement, useMeasurementPreview, usePatchMeasurement } from './api.ts';
import { CustomerStep, customerReady } from './CustomerStep.tsx';
import { EstimateChoice, type PriceChoice } from './EstimateChoice.tsx';
import { readHandoff, type MeasureHandoff } from './handoff.ts';
import styles from './MeasureWindow.module.css';
import { MeasureSwitch } from './windows/MeasureSwitch.tsx';
import { measureStyle, useImageryDate, usesFreeAerial } from './lift/aerial.ts';
import { buildingDetail } from './lift/BuildingPopover.tsx';
import { PropertyStrip } from './lift/PropertyStrip.tsx';
import { ProposalPanel } from './lift/ProposalPanel.tsx';
import { RequestsList } from './lift/RequestsList.tsx';
import { useRequestRows } from './lift/requests.ts';
import { addRoofLayers, facetName, readRoof, usableRoof } from './lift/roofModel.ts';
import { googlePhotoFailure } from './googlePhoto.ts';
import { addRoofPhoto, isRoofPhotoError, removeRoofPhoto, roofPhotoFor } from './lift/roofPhoto.ts';
import { RoofView } from './lift/RoofView.tsx';
import { useRoofScan } from './lift/scan.ts';
import { MeasureSlotsContext, type QuoteSession, type RoofSession } from './lift/slots.ts';
import { addStructureLayers, describeBuildings, onlyIncluded } from './lift/structures.ts';
import { createOutlineEditor, type EditResult, type OutlineEditor } from './OutlineEditor.ts';
import type { MeasurementPatch, MeasurementView, OutlineProblem } from './types.ts';

const SAVE_DEBOUNCE_MS = 500;
// The free aerial photos are sharp to zoom 19: the camera starts there and fitting never goes past 19.5
const START_ZOOM = 19;
const MAX_ZOOM = 20;
const FIT_MAX_ZOOM = 19.5;
const PITCHES = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const MAX_OVERHANG_FT = 3;
const DIAGRAM_SIZE = 24;
const RECOMMENDED_TIER = 'better';

/** The only place the two build-time map settings are read. It is called at use time, so tests can stub them. */
function readMapEnv(): MapEnv {
  return { maptilerKey: import.meta.env.VITE_MAPTILER_KEY, tiles: import.meta.env.VITE_MAP_TILES, imagery: import.meta.env.VITE_MAP_IMAGERY };
}

/** Creates the map over the aerial photo, or answers null when it cannot start (no WebGL). */
function createMap(container: HTMLElement, center: [number, number]): MapLibreMap | null {
  try {
    return new MapLibreMap({
      container,
      style: measureStyle(readMapEnv()),
      center,
      zoom: START_ZOOM,
      maxZoom: MAX_ZOOM,
      // The credits for the photo and the outlines are drawn by the roof view itself
      attributionControl: false,
    });
  } catch {
    return null;
  }
}

type FitMap = { fitBounds?: (b: [[number, number], [number, number]], o: Record<string, unknown>) => void; resize?: () => void };

/** The roof's room at the top of the photo, at least, whatever the card takes. */
const MIN_ROOF_PX = 120;
/** The card's distance from the photo's bottom edge, and the gap kept above it. */
const CARD_INSET_PX = 14;
const CARD_GAP_PX = 18;

/** The free room for the roof, as fitBounds padding: what the measure card covers stays out of it. */
export function roofPadding(w: number, h: number, cardPx: number, editing: boolean): { top: number; bottom: number; left: number; right: number } {
  const top = editing ? Math.round(h * 0.1) + 12 : Math.round(h * 0.18);
  const wanted = Math.max(Math.round(h * 0.27), cardPx > 0 ? cardPx + CARD_INSET_PX + CARD_GAP_PX : 0);
  const bottom = Math.max(0, Math.min(wanted, h - top - MIN_ROOF_PX));
  return { top, bottom, left: Math.round(w * 0.22), right: Math.round(w * 0.22) };
}

/**
 * Frames the roof: centred, in the room above the measure card (a little more room at the bottom when the card is
 * not drawn yet). With Adjust open the card is taller, so the roof is framed higher and smaller, still in sight.
 */
function fitRoof(instance: MapLibreMap, ring: Ring, box: HTMLElement, editing = false, animate = false): void {
  if (ring.length < 3) return;
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (w < 50 || h < 50) return;
  const card = box.parentElement?.querySelector<HTMLElement>('[data-measure-card]');
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    (instance as unknown as FitMap).fitBounds?.(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: roofPadding(w, h, card?.offsetHeight ?? 0, editing), maxZoom: FIT_MAX_ZOOM, duration: animate && !still ? 250 : 0 },
    );
  } catch {
    // A map too small to fit into keeps its start view.
  }
}

function PitchDiagram({ x }: { x: number }) {
  const top = DIAGRAM_SIZE - (DIAGRAM_SIZE * x) / 12;
  return (
    <>
      <svg
        className={styles.diagram}
        viewBox={`0 0 ${DIAGRAM_SIZE} ${DIAGRAM_SIZE}`}
        width={DIAGRAM_SIZE}
        height={DIAGRAM_SIZE}
        aria-hidden="true"
        focusable="false"
      >
        <polygon points={`0,${DIAGRAM_SIZE} ${DIAGRAM_SIZE},${DIAGRAM_SIZE} ${DIAGRAM_SIZE},${top}`} fill="currentColor" />
      </svg>
      <span className="visually-hidden">{measure.pitchDiagram(x)}</span>
    </>
  );
}

function format(value: number): string {
  return value.toLocaleString();
}

function Loaded({ m, onProposalReady }: { m: MeasurementView; onProposalReady: (ready: boolean) => void }) {
  const navigate = useNavigate();
  const [lng, lat] = m.center;
  const patch = usePatchMeasurement(m.id);
  const exact = useExactReport(m.id);
  const me = useMe();
  const canOrderReport = (me.data?.role === 'owner' || me.data?.role === 'office') && m.kind !== 'exact';
  const handoff = readHandoff(useLocation().state);
  const build = useBuildProposal();
  const send = useSendProposal();
  const model = readRoof(m);
  // A roof whose proposal is already out links to it instead of offering to send again
  const { rows: requestRows } = useRequestRows('');
  const sentRow = requestRows.find((r) => r.measurementId === m.id && (r.status === 'estimate_sent' || r.status === 'signed'));
  const scan = useRoofScan(m, model?.totals.facetCount ?? m.facets);
  // Opened by a Measure press: the scan plays straight away
  const autoScan = handoff.autoScan === true;
  const startScan = useRef(scan.start);
  useEffect(() => {
    startScan.current = scan.start;
  });
  useEffect(() => {
    if (autoScan) startScan.current();
  }, [autoScan]);
  const e = m.estimate;
  const preview = useMeasurementPreview(m.id, [e.surfaceSqFt, e.pitchX12, e.edgeFt, e.ridgeFt, e.valleyFt].join(':'));
  const [editing, setEditing] = useState(false);
  const [making, setMaking] = useState(false);
  const [makeFailed, setMakeFailed] = useState<string | null>(null);
  const makingRef = useRef(false);
  const builtRef = useRef<ProposalView | null>(null);
  const [choice, setChoice] = useState<PriceChoice>('free');
  const [customer, setCustomer] = useState<NewCustomerInput>({ name: '', phone: '', askedByText: false });
  // The server also asks for a customer when the home lost its own since this screen loaded
  const [customerAsked, setCustomerAsked] = useState(false);
  const needsCustomer = handoff.jobId === undefined && handoff.customer === undefined && (!m.hasCustomer || customerAsked);

  const [ring, setRing] = useState<Ring>(m.outline?.[0] ?? []);
  const [problem, setProblem] = useState<OutlineProblem | null>(null);
  const [drawMode, setDrawMode] = useState<boolean>(m.drawMode || !m.outline?.[0]?.length);
  const [pitch, setPitch] = useState(m.estimate.pitchX12);
  const [overhangText, setOverhangText] = useState(String(m.overhangFt));
  const [overhang, setOverhang] = useState(m.overhangFt);
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(m.structures.map((s) => [s.footprintId, s.included])),
  );
  // Sections left out of the quote: the server's, or the list just chosen while it is being saved
  const [choosingExcluded, setChoosingExcluded] = useState<string[] | null>(null);
  const excluded = choosingExcluded ?? m.excludedFacets ?? m.roof?.excluded ?? [];
  const [sectionsReset, setSectionsReset] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const facetSaves = useRef(0);
  const seenExcluded = useRef<readonly string[]>(m.excludedFacets ?? m.roof?.excluded ?? []);
  const fromFootprint = useEstimateFromFootprint();
  const fromPoint = useEstimateFromPoint();

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<OutlineEditor | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const overhangTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const patchRef = useRef(patch.mutate);
  const patchAsyncRef = useRef(patch.mutateAsync);
  useEffect(() => {
    patchRef.current = patch.mutate;
    patchAsyncRef.current = patch.mutateAsync;
  });
  const pending = useRef<MeasurementPatch>({});
  // Saves go out one after another; flushing with nothing new waits for the ones already on their way
  const inflight = useRef<Promise<void>>(Promise.resolve());
  const flushPending = useRef((): Promise<void> => {
    clearTimeout(saveTimer.current);
    clearTimeout(overhangTimer.current);
    const body = pending.current;
    pending.current = {};
    if (Object.keys(body).length === 0) return inflight.current;
    const saved = inflight.current
      .then(() => patchAsyncRef.current(body))
      .then((result) => {
        // A new outline, other buildings or another pitch that changed the sections put them all back in the quote
        const before = seenExcluded.current;
        const after = result.excludedFacets ?? [];
        seenExcluded.current = after;
        if (body.excludedFacets !== undefined) setSectionsReset(false);
        else if (before.length > 0 && after.length === 0) setSectionsReset(true);
      });
    inflight.current = saved.catch(() => undefined);
    return saved;
  }).current;
  const startRef = useRef({ ring: m.outline?.[0] ?? [], drawMode: m.drawMode || !m.outline?.[0]?.length, locked: m.locked, model, m });
  const [mapFailed, setMapFailed] = useState(false);
  // Google's roof photo failed with 410 (past Google's 30 days) after the view named it
  const [roofPhotoGone, setRoofPhotoGone] = useState(false);
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
  const [zoom, setZoom] = useState(START_ZOOM);
  const structuresRef = useRef(m.structures);
  useEffect(() => {
    structuresRef.current = m.structures;
  });

  const conflict = patch.error instanceof ApiError && patch.error.status === 409;
  const locked = m.locked || conflict;

  const onEdit = useRef((result: EditResult) => {
    if (result.refused) {
      // The edit was turned down: the outline and what is waiting to be saved stay as they were
      setProblem(result.problem);
      return;
    }
    setRing(result.ring);
    setProblem(result.problem);
    clearTimeout(saveTimer.current);
    if (result.problem !== null) {
      delete pending.current.outline;
      return;
    }
    setDrawMode((current) => (current && result.ring.length >= 3 ? false : current));
    pending.current.outline = [result.ring];
    // A new outline makes new sections: the server says which (if any) stay out
    delete pending.current.excludedFacets;
    setChoosingExcluded(null);
    saveTimer.current = setTimeout(() => {
      void flushPending().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const instance = createMap(container, [lng, lat]);
    if (!instance) {
      queueMicrotask(() => setMapFailed(true));
      return;
    }
    instance.on('error', (event: unknown) => {
      // The roof photo's own failure never fails the map: the photo comes off and, at Google's limit, the view says so
      if (isRoofPhotoError(event)) {
        removeRoofPhoto(instance);
        const url = roofPhotoFor(startRef.current.m)?.url;
        if (url !== undefined) void googlePhotoFailure(url).then((why) => setRoofPhotoGone(why === 'expired'));
        return;
      }
      setMapFailed(true);
    });
    instance.on('zoom', () => setZoom(instance.getZoom()));
    // Set up as soon as the style is ready: 'load' also waits for every first tile, and a slow photo tile must not
    // hold back the roof, its labels and its numbers
    let started = false;
    const setup = () => {
      if (started) return;
      try {
        if (!instance.isStyleLoaded()) return;
      } catch {
        return;
      }
      started = true;
      // Google's true-ortho photo of a roof measured in 3D goes over the map's photo, under everything else
      addRoofPhoto(instance, roofPhotoFor(startRef.current.m));
      // The buildings tint and the facets go in first, so the editable outline draws on top of them
      addStructureLayers(instance, structuresRef.current);
      addRoofLayers(instance, startRef.current.model);
      editorRef.current = createOutlineEditor(instance, {
        ring: startRef.current.ring,
        drawMode: startRef.current.drawMode,
        readOnly: startRef.current.locked,
        onChange: (result) => onEdit.current(result),
      });
      fitRoof(instance, startRef.current.ring, container);
      setMapInstance(instance);
    };
    instance.on('styledata', setup);
    instance.on('load', setup);
    // The proposal column opens beside the roof once it is measured: the photo follows its box
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => (instance as unknown as FitMap).resize?.()) : null;
    observer?.observe(container);
    return () => {
      observer?.disconnect();
      clearTimeout(saveTimer.current);
      clearTimeout(overhangTimer.current);
      if (Object.keys(pending.current).length > 0) {
        patchRef.current(pending.current);
        pending.current = {};
      }
      editorRef.current?.destroy();
      editorRef.current = null;
      instance.remove();
    };
  }, [lng, lat]);

  // A save refused as locked turns the outline read-only too
  useEffect(() => {
    startRef.current.locked = locked;
    editorRef.current?.setReadOnly(locked);
  }, [locked]);

  // Opening or closing Adjust frames the roof again above the card (open, the card is taller)
  const ringRef = useRef(ring);
  useEffect(() => {
    ringRef.current = ring;
  });
  const framedFor = useRef(editing);
  useEffect(() => {
    if (framedFor.current === editing) return;
    framedFor.current = editing;
    const container = containerRef.current;
    if (mapInstance && container) fitRoof(mapInstance, ringRef.current, container, editing, true);
  }, [editing, mapInstance]);

  // The card grows as it fills in (the scan finishing, a review note, the hidden-edge cue): frame the roof above it
  // again each time, so the card never ends up on top of the roof it is about.
  useEffect(() => {
    const container = containerRef.current;
    if (!mapInstance || !container || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => fitRoof(mapInstance, ringRef.current, container, framedFor.current, true));
    const card = container.parentElement?.querySelector<HTMLElement>('[data-measure-card]') ?? null;
    if (card !== null) observer.observe(card);
    return () => observer.disconnect();
  }, [mapInstance, scan.phase]);

  // The photo's date is asked for once the map has started (a map that cannot start shows no photo)
  const captured = useImageryDate(lng, lat, mapInstance !== null && usesFreeAerial(readMapEnv()));
  const done = scan.phase === 'done';
  useEffect(() => {
    onProposalReady(done);
  }, [done, onProposalReady]);

  // While the pitch is still Google Solar's, each facet keeps its own (as the server works it out)
  const ownPitch = (m.pitchSource === 'solar' || m.pitchSource === 'solar-3d') && pitch === m.estimate.pitchX12;
  const planes = ownPitch ? (m.pitchPlanes ?? null) : null;
  // A roof measured in 3D: its faces and lines, while the outline is still its own (as the server works it out)
  const roof3d = m.roof3d ?? null;
  const excludedKey = excluded.join(' ');
  const estimate = useMemo(() => {
    const input = { outline: ring.length > 0 ? [ring] : [], pitchX12: pitch, overhangFt: overhang, valleyFt: m.estimate.valleyFt };
    const out = excludedKey === '' ? [] : excludedKey.split(' ');
    const base = instantEstimate(input);
    const measured = roof3d !== null ? { roof: roof3d, ownPitch } : null;
    // Only some sections quoted, or a roof measured in 3D: the numbers are the roof's (as the server prices them)
    if (out.length > 0 || measured !== null) return measureRoof({ ...input, planes, excludedFacets: out, roof3d: measured }).estimate;
    if (planes === null || planes.length === 0) return base;
    const sloped = measureRoof({ ...input, planes }).estimate;
    return { ...base, surfaceSqFt: sloped.surfaceSqFt, squares: sloped.squares };
  }, [ring, pitch, overhang, m.estimate.valleyFt, planes, excludedKey, roof3d, ownPitch]);
  // The measured roof with the sections left out shaded (and its totals the quoted sections')
  const savedRoofData = m.roof;
  const quotedModel = useMemo(() => {
    const whole = usableRoof(savedRoofData);
    return whole === null ? null : quoteFacets(whole, excludedKey === '' ? [] : excludedKey.split(' '));
  }, [savedRoofData, excludedKey]);

  // Price-changing edits go out at once through the same path as the outline, so Send proposal can wait for them
  const save = (body: MeasurementPatch): Promise<void> => {
    Object.assign(pending.current, body);
    return flushPending().catch(() => {});
  };

  const buildings = describeBuildings(
    m.structures.map((s) => ({ ...s, included: included[s.footprintId] ?? s.included })),
    m.center,
  );
  const lastBuilding = onlyIncluded(buildings);

  const toggleStructure = (id: string, next: boolean) => {
    // The quote always keeps one building: the last one cannot be left out (so there is never no roof to price)
    if (!next && lastBuilding === id) return;
    const map = { ...included, [id]: next };
    setIncluded(map);
    delete pending.current.excludedFacets;
    setChoosingExcluded(null);
    void save({ includedStructures: m.structures.filter((s) => map[s.footprintId]).map((s) => s.footprintId) });
  };

  /** Saves which sections are left out; shown at once, the server's answer (and its prices) follows. */
  const chooseExcluded = (next: string[]) => {
    // An outline or buildings change still on its way makes new sections: a click on the old ones waits for it
    if (pending.current.outline !== undefined || pending.current.includedStructures !== undefined) return;
    const n = ++facetSaves.current;
    setChoosingExcluded(next);
    setSectionsReset(false);
    void save({ excludedFacets: next }).then(() => {
      if (facetSaves.current === n) setChoosingExcluded(null);
    });
  };

  const toggleFacet = (id: string) => {
    if (locked || model === null || model.facets.length < 2) return;
    const out = new Set(excluded);
    if (out.has(id)) out.delete(id);
    else out.add(id);
    // At least one section stays in the quote
    if (out.size >= model.facets.length) return;
    chooseExcluded(model.facets.filter((f) => out.has(f.id)).map((f) => f.id));
  };

  const canMeasureOther = me.data?.role === 'owner' || me.data?.role === 'office';
  const measureOther: QuoteSession['measureOther'] = async ({ lng, lat, footprintId }) => {
    try {
      const { measurementId } =
        footprintId !== null ? await fromFootprint.mutateAsync({ footprintId, lat, lng }) : await fromPoint.mutateAsync({ lat, lng });
      // The new roof opens with its scan playing, as a roof clicked on the main map does
      void navigate(`/estimator/measure/${encodeURIComponent(measurementId)}`, { state: { autoScan: true } satisfies MeasureHandoff });
      return true;
    } catch {
      return false;
    }
  };

  const quote: QuoteSession = {
    excluded,
    toggleFacet,
    includeAll: () => chooseExcluded([]),
    sectionsReset,
    buildings,
    onlyIncluded: lastBuilding,
    toggleBuilding: (id) => {
      const b = buildings.find((x) => x.footprintId === id);
      if (b && !locked) toggleStructure(id, !b.included);
    },
    hovered,
    setHovered,
    canMeasureOther,
    measureOther,
    measuringOther: fromFootprint.isPending || fromPoint.isPending,
  };

  const choosePitch = (x: number) => {
    setPitch(x);
    void save({ pitchX12: x });
  };

  const changeOverhang = (text: string) => {
    setOverhangText(text);
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(MAX_OVERHANG_FT, Math.max(0, value));
    setOverhang(clamped);
    clearTimeout(overhangTimer.current);
    pending.current.overhangFt = clamped;
    overhangTimer.current = setTimeout(() => {
      void flushPending().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  };

  const makeProposal = async () => {
    if (makingRef.current) return;
    makingRef.current = true;
    setMaking(true);
    setMakeFailed(null);
    try {
      await flushPending();
      const built =
        builtRef.current ??
        (await build.mutateAsync({
          measurementId: m.id,
          ...(handoff.jobId !== undefined && { jobId: handoff.jobId }),
          ...(handoff.customer !== undefined && { customer: handoff.customer }),
          ...(needsCustomer && { customer: { name: customer.name.trim(), phone: customer.phone.trim(), askedByText: customer.askedByText } }),
        }));
      builtRef.current = built;
      const sent = await send.mutateAsync(built.id);
      void navigate(`/approvals/${sent.taskId}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400 && error.field === 'customer') setCustomerAsked(true);
      setMakeFailed(makeFailureMessage(error));
    } finally {
      makingRef.current = false;
      setMaking(false);
    }
  };

  const noOutline = drawMode && ring.length < 3;
  const proposalBlocked = making || problem !== null || noOutline || locked || patch.isPending || (needsCustomer && !customerReady(customer));
  const ordering = canOrderReport && (choice === 'exact' || exact.isSuccess);
  const rows: [string, string][] = [
    [measure.area, format(estimate.surfaceSqFt)],
    [measure.squares, format(estimate.squares)],
    [measure.pitch, measure.pitchOption(pitch)],
    [measure.edges, format(estimate.edgeFt)],
    [measure.ridge, format(estimate.ridgeFt)],
    [measure.valley, format(estimate.valleyFt)],
  ];

  const redraw = () => {
    editorRef.current?.setDrawMode(true);
    setDrawMode(true);
    setProblem(null);
  };

  const roof: RoofSession = {
    containerRef,
    map: mapInstance,
    zoom,
    ring,
    drawMode,
    locked,
    conflict,
    problem,
    mapFailed,
    roofPhotoExpired: roofPhotoGone || m.roofPhotoExpired === true,
    saving: patch.isPending,
    saveFailed: patch.isError && !conflict,
    finishDrawing: () => editorRef.current?.finishDrawing(),
    clearDrawing: () => {
      editorRef.current?.clearDrawing();
      setProblem(null);
    },
    redraw,
  };

  const panelsNode = (
    <>
      {buildings.length > 0 ? (
        <section className={styles.panel} aria-labelledby="measure-structures">
          <h3 id="measure-structures" className={styles.title}>
            {measure.structuresTitle}
          </h3>
          <ul className={styles.buildings}>
            {buildings
              .filter((b) => b.listed)
              .map((b) => {
                const name = `${liftMeasure.buildingRole[b.role]} \u00b7 ${buildingDetail(b)}`;
                const last = lastBuilding === b.footprintId;
                return (
                  <li
                    key={b.footprintId}
                    className={styles.building}
                    data-role={b.role}
                    data-hovered={hovered === b.footprintId ? 'true' : undefined}
                    onMouseEnter={() => setHovered(b.footprintId)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(b.footprintId)}
                    onBlur={() => setHovered(null)}
                  >
                    <Checkbox
                      label={name}
                      {...(last ? { description: liftMeasure.lastBuilding } : {})}
                      checked={b.included}
                      disabled={locked || last}
                      onChange={(next) => toggleStructure(b.footprintId, next)}
                    />
                    {canMeasureOther && b.role !== 'main' ? (
                      <Button
                        variant="ghost"
                        className={styles.measureOther}
                        aria-label={liftMeasure.measureRowLabel(name)}
                        busy={quote.measuringOther}
                        onClick={() => {
                          const n = Math.max(b.ring.length, 1);
                          void measureOther({
                            lng: b.ring.reduce((t, p) => t + p[0], 0) / n,
                            lat: b.ring.reduce((t, p) => t + p[1], 0) / n,
                            footprintId: b.footprintId,
                          });
                        }}
                      >
                        {liftMeasure.measureRow}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
          </ul>
          <p className={styles.hint}>{liftMeasure.buildingsHint}</p>
        </section>
      ) : null}

      <section className={styles.panel}>
        <h3 className={styles.title}>{measure.pitchTitle}</h3>
        <div role="group" aria-label={measure.pitchTitle} className={styles.pitches}>
          {PITCHES.map((x) => (
            <Button
              key={x}
              variant="ghost"
              className={styles.pitch}
              aria-pressed={pitch === x}
              data-state={pitch === x ? 'on' : 'off'}
              disabled={locked}
              onClick={() => choosePitch(x)}
            >
              <PitchDiagram x={x} />
              <span>{measure.pitchOption(x)}</span>
            </Button>
          ))}
        </div>
      </section>

      <section className={styles.panel}>
        <Field
          label={measure.overhangTitle}
          type="number"
          inputMode="decimal"
          step={0.5}
          min={0}
          max={MAX_OVERHANG_FT}
          value={overhangText}
          disabled={locked}
          onChange={(event) => changeOverhang(event.target.value)}
        />
      </section>

      <section className={styles.panel} aria-labelledby="measure-numbers">
        <h3 id="measure-numbers" className={styles.title}>
          {measure.numbersTitle}
        </h3>
        {model !== null && model.facets.length > 1 ? <p className={styles.hint}>{liftMeasure.sectionsRule}</p> : null}
        <dl className={styles.numbers}>
          {rows.map(([label, value]) => (
            <div key={label} className={styles.row}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {!mapFailed && !locked && !drawMode ? (
        <Button variant="ghost" className={styles.wide} onClick={redraw}>
          {measure.redraw}
        </Button>
      ) : null}
    </>
  );

  const controls = (
    <>
      {canOrderReport ? <EstimateChoice choice={choice} onChoose={setChoice} disabled={exact.isPending || exact.isSuccess} /> : null}
      {needsCustomer && !ordering ? <CustomerStep value={customer} onChange={setCustomer} disabled={making} /> : null}
    </>
  );

  const footer = (
    <div className={styles.actions}>
      {!ordering ? null : exact.isSuccess ? (
        <div className={styles.waiting} role="status">
          <Button variant="ghost" className={styles.wide} href={`/approvals/${exact.data.taskId}`}>
            {measure.waitingForOk}
          </Button>
        </div>
      ) : (
        <Button
          className={styles.send}
          busy={exact.isPending}
          disabled={exact.isPending}
          onClick={() => void flushPending().then(() => exact.mutate(), () => {})}
        >
          {paidReports.exactRequest}
        </Button>
      )}
      {exact.isError ? <Banner tone="danger">{measure.exactFailed}</Banner> : null}
      {ordering ? null : locked && sentRow !== undefined ? (
        <Button variant="ghost" className={styles.sent} href={`/estimator/proposals/${sentRow.proposalId}`}>
          {liftProposal.sentView(sentRow.status === 'signed')}
        </Button>
      ) : (
        <Button className={styles.send} busy={making} disabled={proposalBlocked} onClick={() => void makeProposal()}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="m22 2-7 20-4-9-9-4Z" />
            <path d="M22 2 11 13" />
          </svg>
          {measure.makeProposal}
        </Button>
      )}
      {makeFailed !== null ? (
        <div role="alert">
          <Banner tone="danger">{makeFailed}</Banner>
        </div>
      ) : null}
    </div>
  );

  const recommended = preview.data?.options?.find((o) => o.tier === RECOMMENDED_TIER) ?? preview.data?.options?.[0];
  // The sections the prices cover, when not the whole roof (as the server saved them)
  const savedRoof = readRoof(m);
  const savedOut = new Set(savedRoof?.excluded ?? []);
  const sectionsLine =
    savedRoof !== null && savedOut.size > 0
      ? liftProposal.sectionsOnly(
          savedRoof.facets.flatMap((f, i) => (savedOut.has(f.id) ? [] : [facetName(f.id, i)])),
          savedRoof.facets.length,
        )
      : null;
  const typedName = needsCustomer && customer.name.trim() !== '' ? customer.name : null;
  const customerName = handoff.customer?.name ?? typedName ?? preview.data?.customerName ?? null;

  return (
    <MeasureSlotsContext
      value={{
        roof,
        panels: panelsNode,
        estimate,
        scan,
        model: quotedModel,
        wastePct: recommended?.wastePercent ?? null,
        editing,
        setEditing,
        quote,
      }}
    >
      <div className={styles.main}>
        <PropertyStrip measurementId={m.id} preview={preview.data} />
        <RoofView measurementId={m.id} captured={captured} />
      </div>
      {done ? (
        <div className={styles.proposal}>
          <ProposalPanel
            preview={preview.data}
            pending={preview.isPending}
            failed={preview.isError}
            customerName={customerName}
            sections={sectionsLine}
            controls={controls}
            footer={footer}
          />
        </div>
      ) : null}
    </MeasureSlotsContext>
  );
}

/** /estimator with no request open: the first request opens (replacing this address), or the right side says what to do. */
function NothingOpen() {
  const navigate = useNavigate();
  // Opened to measure a typed address (`?measure=`): that measurement opens when it is ready, not the first request
  const [params] = useSearchParams();
  const measuring = params.has('measure');
  const { list, rows } = useRequestRows('');
  const first = rows[0]?.measurementId;
  useEffect(() => {
    if (first !== undefined && !measuring) void navigate(`/estimator/measure/${encodeURIComponent(first)}`, { replace: true });
  }, [first, measuring, navigate]);
  if (measuring) {
    return (
      <p className={styles.loading} role="status">
        {measure.measureNewBusy}
      </p>
    );
  }
  if (list.isPending || first !== undefined) return <p className={styles.loading}>{measure.loading}</p>;
  return (
    <div className={styles.pick}>
      <EmptyState title={measure.pickRequest} />
    </div>
  );
}

type Step = 'requests' | 'roof' | 'proposal';
const STEPS: Step[] = ['requests', 'roof', 'proposal'];

/** The phone's three steps, as the reference numbers them: Requests, Roof, Proposal. */
function Steps({ step, onStep, proposalReady, roofReady }: { step: Step; onStep: (s: Step) => void; proposalReady: boolean; roofReady: boolean }) {
  return (
    <div className={styles.steps} role="tablist" aria-label={liftMeasureSteps.label}>
      {STEPS.map((s, i) => {
        const disabled = (s === 'roof' && !roofReady) || (s === 'proposal' && !proposalReady);
        return (
          <Button
            key={s}
            variant="ghost"
            role="tab"
            aria-selected={step === s}
            data-selected={step === s ? 'true' : undefined}
            disabled={disabled}
            className={styles.step}
            onClick={() => onStep(s)}
          >
            <span className={styles.stepNumber} aria-hidden="true">
              {i + 1}
            </span>
            {liftMeasureSteps[s]}
          </Button>
        );
      })}
    </div>
  );
}

/** The measuring screen: the requests on the left, the roof in the middle, the proposal on the right once measured. */
export function MeasureWindow() {
  const { measurementId = '' } = useParams();
  const query = useMeasurement(measurementId);
  const [step, setStep] = useState<Step>(measurementId === '' ? 'requests' : 'roof');
  const [proposalReady, setProposalReady] = useState(false);
  // Opening another roof shows it (on a phone the requests step gives way to the roof)
  const [shownId, setShownId] = useState(measurementId);
  if (shownId !== measurementId) {
    setShownId(measurementId);
    setStep(measurementId === '' ? 'requests' : 'roof');
    setProposalReady(false);
  }
  const activeStep: Step = step === 'proposal' && !proposalReady ? 'roof' : step;

  return (
    <div className={styles.window} data-step={activeStep} data-proposal={proposalReady ? 'true' : 'false'}>
      <header className={styles.header}>
        <span className={styles.appIcon} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
            <path
              d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0ZM14.5 12.5l2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <h2 className={styles.heading}>{measure.title}</h2>
        <MeasureSwitch
          current="roof"
          roofHref="/estimator"
          windowsHref={query.data !== undefined ? `/estimator/windows?property=${encodeURIComponent(query.data.propertyId)}` : '/estimator/windows'}
          guttersHref={query.data !== undefined && query.data.roof !== null ? `/estimator/measure/${encodeURIComponent(query.data.id)}/gutters` : null}
        />
        <span className={styles.subtitle}>{measure.subtitle}</span>
      </header>
      <Steps step={activeStep} onStep={setStep} roofReady={measurementId !== ''} proposalReady={proposalReady} />
      <div className={styles.body}>
        <aside className={styles.list}>
          <RequestsList selectedId={measurementId} onPick={() => setStep('roof')} />
        </aside>
        {measurementId === '' ? (
          <div className={styles.main}>
            <NothingOpen />
          </div>
        ) : query.data ? (
          // A failed refetch keeps the roof on screen: only a measurement that never loaded shows the failure
          <Loaded key={query.data.id} m={query.data} onProposalReady={setProposalReady} />
        ) : query.isError ? (
          <div className={styles.main}>
            <EmptyState title={measure.loadFailed} />
          </div>
        ) : (
          <div className={styles.main}>
            <p className={styles.loading}>{measure.loading}</p>
          </div>
        )}
      </div>
    </div>
  );
}
