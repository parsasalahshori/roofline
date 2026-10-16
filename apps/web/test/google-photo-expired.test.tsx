import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FacadePhoto } from '@roofline/shared';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { legal } from '../src/copy/legal.ts';
import { measureWindows as copy } from '../src/copy/measureWindows.ts';
import { googlePhotoFailure } from '../src/features/measure/googlePhoto.ts';
import { Notices } from '../src/features/measure/lift/RoofView.tsx';
import { isRoofPhotoError, removeRoofPhoto, ROOF_PHOTO_LAYER, ROOF_PHOTO_SOURCE } from '../src/features/measure/lift/roofPhoto.ts';
import { PhotoStage, type StageEdit } from '../src/features/measure/windows/PhotoStage.tsx';

/*
 * Google's photos past their 30 days (docs/compliance/google-data-retention.md): the server answers 410 and the views
 * mark them expired; the roof view and the windows photo area say so instead of breaking.
 */

const EXPIRED = "Photo expired (Google's 30-day limit). Re-measure to see it again.";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PHOTO: FacadePhoto = { id: 'p1', heading: 0, fov: 60, widthPx: 640, heightPx: 640, capturedOn: '2023-06', distanceM: 18 };
const EDIT: StageEdit = {
  editing: false,
  marking: false,
  locked: false,
  selected: null,
  select: () => undefined,
  toggle: () => undefined,
  draw: () => undefined,
  changeBox: () => undefined,
  remove: () => undefined,
  moveCorners: () => undefined,
};

function stage(photo: FacadePhoto) {
  return render(
    <PhotoStage
      photo={photo}
      src="/api/window-measurements/w1/photos/p1"
      address="1 Main St"
      windows={[]}
      numberOf={() => 0}
      excluded={new Set()}
      corners={null}
      scan={{ phase: 'done', progress: 1 }}
      edit={EDIT}
    />,
  );
}

describe('expired Google photos', () => {
  it('the copy says what happened and what to do', () => {
    expect(legal.googlePhotoExpired).toBe(EXPIRED);
  });

  it('a Street View photo the view marks expired is not loaded; the photo area says it expired', () => {
    stage({ ...PHOTO, expired: true });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(EXPIRED);
  });

  it('a photo that fails with 410 says it expired; any other failure says it did not load', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 410 }));
    vi.stubGlobal('fetch', fetchMock);
    stage(PHOTO);
    fireEvent.error(screen.getByRole('img'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(EXPIRED));
    expect(fetchMock).toHaveBeenCalledWith('/api/window-measurements/w1/photos/p1', { method: 'HEAD', credentials: 'same-origin' });
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    stage(PHOTO);
    fireEvent.error(screen.getByRole('img'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(copy.photoFailed));
  });

  it('googlePhotoFailure: 410 is expired; 404, 500 and a network error are failed', async () => {
    expect(await googlePhotoFailure('/x', async () => new Response(null, { status: 410 }))).toBe('expired');
    expect(await googlePhotoFailure('/x', async () => new Response(null, { status: 404 }))).toBe('failed');
    expect(await googlePhotoFailure('/x', async () => new Response(null, { status: 500 }))).toBe('failed');
    expect(await googlePhotoFailure('/x', async () => Promise.reject(new Error('offline')))).toBe('failed');
  });

  it('the roof view says the roof photo expired (and nothing when it has not)', () => {
    const base = { mapFailed: false, locked: false, problem: null, saveFailed: false, drawMode: false, finishDrawing: () => undefined, clearDrawing: () => undefined };
    const { container, rerender } = render(<Notices roof={{ ...base, roofPhotoExpired: true }} />);
    expect(container.querySelector('[data-roof-photo-expired]')).toHaveTextContent(EXPIRED);
    rerender(<Notices roof={{ ...base, roofPhotoExpired: false }} />);
    expect(container.querySelector('[data-roof-photo-expired]')).toBeNull();
  });

  it("the roof photo's own load error is told apart from the map's, and the photo comes off the map", () => {
    expect(isRoofPhotoError({ sourceId: ROOF_PHOTO_SOURCE })).toBe(true);
    expect(isRoofPhotoError({ sourceId: 'google-tiles' })).toBe(false);
    expect(isRoofPhotoError(new Error('x'))).toBe(false);
    const removed: string[] = [];
    const map = {
      getLayer: (id: string) => (id === ROOF_PHOTO_LAYER ? {} : undefined),
      getSource: (id: string) => (id === ROOF_PHOTO_SOURCE ? {} : undefined),
      removeLayer: (id: string) => removed.push(`layer:${id}`),
      removeSource: (id: string) => removed.push(`source:${id}`),
    } as unknown as MapLibreMap;
    removeRoofPhoto(map);
    expect(removed).toEqual([`layer:${ROOF_PHOTO_LAYER}`, `source:${ROOF_PHOTO_SOURCE}`]);
  });
});
