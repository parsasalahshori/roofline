import { useParams } from 'react-router';
import { RouteView } from './RouteView.tsx';

/** One route on the phone, read from the route id in the address. */
export function RouteDetail() {
  const { routeId } = useParams();
  return <RouteView routeId={routeId ?? ''} />;
}
