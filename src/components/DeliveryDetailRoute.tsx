import { useParams } from 'react-router-dom';
import DeliveryDetail from '../pages/DeliveryDetail';

/**
 * Route element for `deliveries/:id`. Its only job is to remount DeliveryDetail whenever the
 * delivery in the URL changes, the same way JobDetailRoute does for jobs.
 *
 * React reuses a component when only its props change, so `/deliveries/a` -> `/deliveries/b`
 * kept one DeliveryDetail alive and poured the next record into it. The page never resets its
 * edit state (`editing`, `editItems`) on a change of record, so an edit opened on delivery A
 * stayed open over delivery B with A's rows. Keying by the route id discards the old instance
 * and every piece of state it held. (Readability report B4, 2026-10-23.)
 *
 * The page's own reset effects and route-id checks are kept: they are harmless under a remount,
 * and removing them was not part of this fix.
 */
export default function DeliveryDetailRoute() {
  const { id } = useParams();
  return <DeliveryDetail key={id} />;
}
