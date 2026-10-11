/*
 * A stand-in for the real map, which Task 11 builds in parallel and which replaces this file at
 * merge. Tests of the shell mock this module (vi.mock) and never load the real map.
 */
export type MapViewProps = {
  onOpen(target: { kind: 'customer' | 'job'; id: string }): void;
};

export function MapView(props: MapViewProps) {
  void props;
  return <div data-map-stub />;
}
