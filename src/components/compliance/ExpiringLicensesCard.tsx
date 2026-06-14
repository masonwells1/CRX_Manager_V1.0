/**
 * ExpiringLicensesCard — Dashboard renewal reminders (deep-dive H1 B5)
 *
 * Admin/sales-rep card listing applicator licenses that RECENTLY lapsed (within
 * the last 30 days) or expire within the next 60 days — the actionable renewal
 * window. Renders nothing when there's nothing to act on.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert, ChevronRight } from 'lucide-react';
import Card from '../ui/Card';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { localToday, localDatePlusDays } from '../../lib/dateUtils';

interface ExpiringLicense {
  id: string;
  holder_name: string;
  license_type: string;
  expiry_date: string;
  customer_id: string | null;
  profile_id: string | null;
  farm_name: string | null;
}

export default function ExpiringLicensesCard() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ExpiringLicense[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('applicator_licenses')
        .select('id, holder_name, license_type, expiry_date, customer_id, profile_id, customer:customers(farm_name)')
        .eq('is_active', true)
        // Actionable renewal window: recently lapsed (last 30 days) through the
        // next 60 days. The lower bound stops indefinitely-old expired licenses
        // from crowding out imminent renewals under the limit(6) (Codex 2026-06-13).
        .gte('expiry_date', localDatePlusDays(-30))
        .lte('expiry_date', localDatePlusDays(60))
        .order('expiry_date', { ascending: true })
        .limit(6);
      if (error) {
        // Non-critical dashboard card — log, don't toast
        Sentry.captureException(error, { tags: { source: 'dashboard', card: 'expiring_licenses' } });
        return;
      }
      if (!cancelled) {
        setRows(
          ((data || []) as Array<Record<string, unknown> & { customer?: { farm_name?: string } }>).map((l) => ({
            id: l.id as string,
            holder_name: l.holder_name as string,
            license_type: l.license_type as string,
            expiry_date: l.expiry_date as string,
            customer_id: (l.customer_id as string) || null,
            profile_id: (l.profile_id as string) || null,
            farm_name: l.customer?.farm_name || null,
          })),
        );
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (rows.length === 0) return null;

  const today = localToday();

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-yellow-600" />
          <h2 className="font-semibold text-nav-dark">
            Licenses <span className="text-crx-green">Expiring</span>
          </h2>
        </div>
        <button
          onClick={() => navigate('/compliance')}
          className="flex items-center gap-1 text-sm text-crx-green hover:underline"
        >
          Compliance <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="divide-y divide-gray-100">
        {rows.map((l) => {
          const expired = l.expiry_date < today;
          return (
            <div key={l.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <span className="font-medium text-nav-dark">{l.holder_name}</span>
                <span className="ml-2 text-gray-500">
                  {l.profile_id ? 'Staff' : l.farm_name || 'Customer'} · {l.license_type}
                </span>
              </div>
              <span className={`font-medium ${expired ? 'text-red-600' : 'text-yellow-600'}`}>
                {expired ? `Expired ${l.expiry_date}` : `Expires ${l.expiry_date}`}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
