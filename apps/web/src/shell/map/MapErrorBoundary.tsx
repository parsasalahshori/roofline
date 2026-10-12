import { Component, type ErrorInfo, type ReactNode } from 'react';
import { mapCopy } from '../../copy/map.ts';
import styles from './MapErrorBoundary.module.css';

export type MapErrorBoundaryProps = { children: ReactNode };
export type MapErrorBoundaryState = { failed: boolean };

/**
 * Catches a failure of the map (a chunk that will not load, or a render that throws) so the rest
 * of the shell stays usable. The fallback is the map's own banner (spec 4.3). The shell gives it a
 * key that changes with the company, so a switch makes a fresh map and clears a failure.
 */
export class MapErrorBoundary extends Component<MapErrorBoundaryProps, MapErrorBoundaryState> {
  state: MapErrorBoundaryState = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept for whoever reads the browser console; the person sees only the banner
    console.error('The map failed to load', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="status" className={styles.status} data-state="error">
        <p className={styles.banner}>{mapCopy.error}</p>
      </div>
    );
  }
}
