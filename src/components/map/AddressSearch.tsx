import { useState, useCallback, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
const COORD_REGEX = /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/;

interface GeocodingResult {
  place_name: string;
  center: [number, number];
}

interface AddressSearchProps {
  onSelect: (longitude: number, latitude: number) => void;
}

export default function AddressSearch({ onSelect }: AddressSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodingResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const geocode = useCallback(async (text: string) => {
    if (!MAPBOX_TOKEN || text.length < 3) {
      setResults([]);
      return;
    }
    try {
      const res = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(text)}.json?access_token=${MAPBOX_TOKEN}&country=US&limit=5`
      );
      const data = await res.json();
      const features = (data.features || []) as Array<{ place_name: string; center: [number, number] }>;
      setResults(features.map((f) => ({ place_name: f.place_name, center: f.center })));
      setShowResults(true);
    } catch {
      setResults([]);
    }
  }, []);

  const handleChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => geocode(value), 300);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const match = query.match(COORD_REGEX);
    if (match) {
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      onSelect(lng, lat);
      setShowResults(false);
      return;
    }
    if (results.length > 0) {
      onSelect(results[0].center[0], results[0].center[1]);
      setQuery(results[0].place_name);
      setShowResults(false);
    }
  };

  const handleSelect = (result: GeocodingResult) => {
    onSelect(result.center[0], result.center[1]);
    setQuery(result.place_name);
    setShowResults(false);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="absolute top-4 left-14 z-10 w-64 sm:w-80">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => results.length > 0 && setShowResults(true)}
          placeholder="Search address or coordinates..."
          className="w-full pl-9 pr-8 py-2 bg-white rounded-lg shadow-md border-0 text-sm focus:ring-2 focus:ring-crx-green focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setResults([]);
              setShowResults(false);
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {showResults && results.length > 0 && (
        <div className="mt-1 bg-white rounded-lg shadow-lg border max-h-48 overflow-y-auto">
          {results.map((r, i) => (
            <button
              key={i}
              type="button"
              onClick={() => handleSelect(r)}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 border-b last:border-b-0"
            >
              {r.place_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
