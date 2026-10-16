import { lazy } from 'react';

/** The AR measuring screen, fetched only when someone opens it (nothing AR loads for phones without AR). */
export const LazyArMeasure = lazy(() => import('./ArMeasure.tsx'));
