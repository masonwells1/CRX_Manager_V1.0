import { useEffect, useState } from 'react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { formatCents as fmt } from '../../lib/money';

interface ApplicationService {
  id: string;
  name: string;
  default_rate_per_acre_cents: number;
  is_active: boolean;
}

interface ApplicationServicePickerProps {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}


/**
 * Dropdown for selecting an application service (Hagie Y-Drop, airplane, etc.).
 * Drives the per-acre fee calculation in save_field_app_invoice.
 *
 * Phase 1 (2026-04-29): introduced when invoices.application_service_id was added.
 */
export default function ApplicationServicePicker({
  value,
  onChange,
  disabled = false,
}: ApplicationServicePickerProps) {
  const [services, setServices] = useState<ApplicationService[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('application_services')
        .select('id, name, default_rate_per_acre_cents, is_active')
        .eq('is_active', true)
        .order('sort_order')
        .order('name');
      if (cancelled) return;
      if (error) {
        Sentry.captureException(error, { tags: { component: 'ApplicationServicePicker' } });
        setServices([]);
      } else {
        setServices((data || []) as ApplicationService[]);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={disabled || loading}
      className="w-full px-3 py-2 border rounded-lg text-sm bg-white disabled:bg-gray-50 disabled:text-gray-400"
    >
      <option value="">{loading ? 'Loading services...' : 'No service fee'}</option>
      {services.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name} ({fmt(s.default_rate_per_acre_cents)}/ac default)
        </option>
      ))}
    </select>
  );
}
