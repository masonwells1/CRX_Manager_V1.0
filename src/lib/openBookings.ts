import { supabase } from './db';
import { Sentry } from './sentry';

export interface OpenBooking {
  id: string;
  quote_number: string;
  status: string;
}

/**
 * Per the quote lifecycle, a sent/revised quote is an OPEN BOOKING that can be
 * drawn down into orders at locked prices (`draw_down_quote`). Order-entry
 * surfaces warn before selling the same product outside the booking.
 */
export async function fetchOpenBookings(customerId: string): Promise<OpenBooking[]> {
  try {
    const { data, error } = await supabase
      .from('quotes')
      .select('id, quote_number, status')
      .eq('customer_id', customerId)
      .in('status', ['sent', 'revised'])
      .is('deleted_at', null)
      .order('quote_number');

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'open_bookings' } });
      return [];
    }

    return (data || []) as OpenBooking[];
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { source: 'fetch', action: 'open_bookings' } }
    );
    return [];
  }
}
