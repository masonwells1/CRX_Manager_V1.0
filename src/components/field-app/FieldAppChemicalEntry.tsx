import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Trash2, BookOpen, Save } from 'lucide-react';
import Button from '../ui/Button';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import type { Product } from '../../types';

export interface ChemicalLine {
  id: string;
  product_id: string | null;
  product_name: string;
  rate_per_acre: number | null;
  rate_unit: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  price_unit: string;
  extended_cents: number;
  unit_cost_cents: number;
  sort_order: number;
  epa_registration?: string;
}

interface Recipe {
  id: string;
  name: string;
  items: Array<{
    product_id: string;
    product_name: string;
    quantity: number;
    unit: string;
    rate_per_acre: number | null;
  }>;
}

interface FieldAppChemicalEntryProps {
  chemicals: ChemicalLine[];
  onChemicalsChange: (chemicals: ChemicalLine[]) => void;
  totalAppliedAcres: number;
  recipes?: Recipe[];
}

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

let nextLineId = 1;
function genId() {
  return `chem_${Date.now()}_${nextLineId++}`;
}

export default function FieldAppChemicalEntry({
  chemicals,
  onChemicalsChange,
  totalAppliedAcres,
}: FieldAppChemicalEntryProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  const searchProducts = useCallback(async (q: string) => {
    if (q.length < 2) { setSearchResults([]); return; }
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .or(`product_name.ilike.%${q}%,epa_registration.ilike.%${q}%`)
      .order('product_name')
      .limit(15);

    if (error) {
      Sentry.captureException(error, { tags: { component: 'FieldAppChemicalEntry' } });
      return;
    }
    setSearchResults((data || []) as Product[]);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { if (searchQuery) searchProducts(searchQuery); }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery, searchProducts]);

  // Close search on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearch(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const addLine = () => {
    const line: ChemicalLine = {
      id: genId(),
      product_id: null,
      product_name: '',
      rate_per_acre: null,
      rate_unit: 'oz',
      quantity: 0,
      unit: 'oz',
      unit_price_cents: 0,
      price_unit: 'oz',
      extended_cents: 0,
      unit_cost_cents: 0,
      sort_order: chemicals.length,
    };
    onChemicalsChange([...chemicals, line]);
    setActiveLineId(line.id);
    setShowSearch(true);
    setSearchQuery('');
    setSearchResults([]);
  };

  const removeLine = (id: string) => {
    onChemicalsChange(chemicals.filter((c) => c.id !== id));
  };

  const updateLine = (id: string, updates: Partial<ChemicalLine>) => {
    onChemicalsChange(
      chemicals.map((c) => {
        if (c.id !== id) return c;
        const updated = { ...c, ...updates };
        // Recalc quantity and total
        if (updated.rate_per_acre && totalAppliedAcres > 0) {
          updated.quantity = Number((updated.rate_per_acre * totalAppliedAcres).toFixed(2));
        }
        updated.extended_cents = Math.round(updated.quantity * updated.unit_price_cents);
        return updated;
      })
    );
  };

  const selectProduct = (product: Product, lineId: string) => {
    updateLine(lineId, {
      product_id: product.id,
      product_name: product.product_name,
      rate_per_acre: product.rate_per_acre || null,
      rate_unit: product.rate_unit || product.inventory_unit || 'oz',
      unit: product.inventory_unit || 'oz',
      unit_price_cents: Math.round((product.tier1_price || 0) * 100),
      price_unit: product.inventory_unit || 'oz',
      unit_cost_cents: Math.round((product.current_cost || 0) * 100),
      epa_registration: product.epa_registration || undefined,
    });
    setShowSearch(false);
    setSearchQuery('');
  };

  const invoiceTotal = chemicals.reduce((sum, c) => sum + c.extended_cents, 0);
  const pricePerAcre = totalAppliedAcres > 0 ? invoiceTotal / totalAppliedAcres : 0;

  return (
    <div className="space-y-4">
      {/* Product lines */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b">
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-[250px]">Product</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 w-24">Rate/Acre</th>
              <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 w-16">UM</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 w-28">Total Applied</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 w-28">Price</th>
              <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 w-16">Price UM</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 w-28">Line Total</th>
              <th className="px-3 py-2 w-10" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {chemicals.map((line) => (
              <tr key={line.id} className="hover:bg-gray-50">
                <td className="px-3 py-2">
                  <div className="relative" ref={activeLineId === line.id ? searchRef : undefined}>
                    {line.product_name ? (
                      <div
                        className="font-medium cursor-pointer hover:text-crx-green"
                        onClick={() => {
                          setActiveLineId(line.id);
                          setShowSearch(true);
                          setSearchQuery('');
                        }}
                      >
                        {line.product_name}
                        {line.epa_registration && (
                          <span className="text-xs text-gray-400 ml-1">EPA: {line.epa_registration}</span>
                        )}
                      </div>
                    ) : (
                      <input
                        type="text"
                        placeholder="Search product..."
                        value={activeLineId === line.id ? searchQuery : ''}
                        onChange={(e) => { setSearchQuery(e.target.value); setActiveLineId(line.id); setShowSearch(true); }}
                        onFocus={() => { setActiveLineId(line.id); setShowSearch(true); }}
                        className="w-full px-2 py-1 border rounded text-sm"
                      />
                    )}
                    {showSearch && activeLineId === line.id && searchResults.length > 0 && (
                      <div className="absolute z-20 top-full left-0 w-80 mt-1 bg-white border rounded-lg shadow-lg max-h-60 overflow-auto">
                        {searchResults.map((p) => (
                          <div
                            key={p.id}
                            className="px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm"
                            onClick={() => selectProduct(p, line.id)}
                          >
                            <div className="font-medium">{p.product_name}</div>
                            {p.epa_registration && <div className="text-xs text-gray-400">EPA: {p.epa_registration}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="0.01"
                    value={line.rate_per_acre ?? ''}
                    onChange={(e) => updateLine(line.id, { rate_per_acre: e.target.value ? Number(e.target.value) : null })}
                    className="w-full px-2 py-1 border rounded text-right text-sm tabular-nums"
                  />
                </td>
                <td className="px-3 py-2 text-center text-gray-600">{line.rate_unit}</td>
                <td className="px-3 py-2 text-right tabular-nums">{line.quantity.toFixed(2)}</td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="1"
                    value={line.unit_price_cents}
                    onChange={(e) => updateLine(line.id, { unit_price_cents: Number(e.target.value) || 0 })}
                    className="w-full px-2 py-1 border rounded text-right text-sm tabular-nums"
                  />
                </td>
                <td className="px-3 py-2 text-center text-gray-600">{line.price_unit}</td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">{fmt(line.extended_cents)}</td>
                <td className="px-3 py-2">
                  <button onClick={() => removeLine(line.id)} className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
            {chemicals.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">No chemicals added yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add button + recipe buttons */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" icon={<Plus className="w-4 h-4" />} onClick={addLine}>
            Add Chemical
          </Button>
          <Button variant="ghost" size="sm" icon={<BookOpen className="w-4 h-4" />} onClick={() => { /* TODO: recipe picker */ }}>
            Select Recipe
          </Button>
          <Button variant="ghost" size="sm" icon={<Save className="w-4 h-4" />} onClick={() => { /* TODO: save recipe */ }}>
            Save As Recipe
          </Button>
        </div>
      </div>

      {/* Summary */}
      <div className="flex justify-end gap-6 text-sm pt-2 border-t">
        <div className="text-gray-600">
          Price/Acre: <span className="font-semibold text-gray-900">{fmt(Math.round(pricePerAcre))}</span>
        </div>
        <div className="text-gray-600">
          Invoice Total: <span className="font-semibold text-gray-900 text-base">{fmt(invoiceTotal)}</span>
        </div>
      </div>
    </div>
  );
}
