import { useState } from 'react';
import { Search, Users, AlertCircle } from 'lucide-react';
import type { Customer } from '../../types';
import { resolveFieldCustomerId, type AssignableField } from '../../lib/fieldImportCustomers';

export interface FieldCustomerAssignmentProps {
  fields: AssignableField[];
  customers: Customer[];
  /** Per-field OVERRIDES: field index -> customer_id. Fields not present here use the fallback. */
  assignments: Record<number, string>;
  /** The "apply to all" customer — the single source of truth for the fast path; '' when unset. */
  fallbackCustomerId?: string;
  /** Set one field's customer (an override). */
  onAssign: (index: number, customerId: string) => void;
  /** Set EVERY field's customer at once (the fast single-customer path). */
  onApplyToAll: (customerId: string) => void;
}

/** A searchable customer picker — filters only while open so a big customer list stays cheap. */
function CustomerSelect({
  customers,
  selectedName,
  placeholder,
  ariaLabel,
  invalid = false,
  onSelect,
}: {
  customers: Customer[];
  selectedName: string;
  placeholder: string;
  ariaLabel: string;
  invalid?: boolean;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const filtered = open
    ? customers.filter((c) => c.farm_name.toLowerCase().includes(search.toLowerCase())).slice(0, 20)
    : [];

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
        <input
          type="text"
          aria-label={ariaLabel}
          value={open ? search : selectedName}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setSearch('');
            setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          placeholder={placeholder}
          className={`w-full pl-8 pr-3 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green ${
            invalid ? 'border-red-300 bg-red-50' : 'border-gray-200'
          }`}
        />
      </div>
      {open && (
        <div className="absolute z-30 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-secondary">No customers found</div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(c.id);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-crx-green-tint transition-colors"
              >
                {c.farm_name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Per-field customer assignment for the shapefile importer (SOW-F3). A real county / co-op export
 * often covers many growers, so each imported field can go to its own customer. "Apply to all" keeps
 * today's fast single-customer path (one pick assigns every field); the per-field rows let you point
 * individual fields elsewhere. A field's effective customer = its override, else the apply-to-all
 * fallback — the SAME resolveFieldCustomerId the wizard's gate uses, so what you see here matches what
 * imports. Purely presentational — all state lives in the parent wizard — so it unit-tests from props.
 */
export default function FieldCustomerAssignment({
  fields,
  customers,
  assignments,
  fallbackCustomerId,
  onAssign,
  onApplyToAll,
}: FieldCustomerAssignmentProps) {
  const nameById = new Map(customers.map((c) => [c.id, c.farm_name]));
  const unassigned = fields.filter(
    (f) => !resolveFieldCustomerId(f.index, assignments, fallbackCustomerId),
  ).length;

  return (
    <div className="space-y-3">
      {/* Apply to all — the fast single-customer path */}
      <div className="p-3 bg-crx-green-light border border-crx-green/20 rounded-lg">
        <label className="flex items-center gap-1.5 text-sm font-medium text-nav-dark mb-1.5">
          <Users className="w-4 h-4 text-crx-green" />
          Apply one customer to all {fields.length} field{fields.length === 1 ? '' : 's'}
        </label>
        <CustomerSelect
          customers={customers}
          selectedName=""
          ariaLabel="Apply one customer to all fields"
          placeholder="Search a customer to assign to every field..."
          onSelect={onApplyToAll}
        />
        <p className="text-xs text-secondary mt-1.5">
          Most imports are one grower — pick once here. For a mixed county/co-op file, set individual
          fields below.
        </p>
      </div>

      {/* Per-field assignment */}
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
          <span className="text-xs font-medium text-secondary">Field</span>
          <span className="text-xs font-medium text-secondary">Customer</span>
        </div>
        <div className="max-h-72 overflow-y-auto divide-y divide-gray-100">
          {fields.map((f) => {
            const resolvedId = resolveFieldCustomerId(f.index, assignments, fallbackCustomerId);
            const resolvedName = resolvedId ? nameById.get(resolvedId) ?? '' : '';
            return (
              <div key={f.index} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-nav-dark truncate">{f.name}</p>
                  <p className="text-xs text-secondary">{f.acres.toFixed(1)} ac</p>
                </div>
                <div className="w-52 shrink-0">
                  <CustomerSelect
                    customers={customers}
                    selectedName={resolvedName}
                    ariaLabel={`Customer for ${f.name}`}
                    placeholder="Choose customer..."
                    invalid={!resolvedId}
                    onSelect={(id) => onAssign(f.index, id)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {unassigned > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
          <p className="text-xs text-amber-700">
            {unassigned} field{unassigned === 1 ? '' : 's'} still need{unassigned === 1 ? 's' : ''} a
            customer. Use &quot;Apply to all&quot; above or pick one for each.
          </p>
        </div>
      )}
    </div>
  );
}
