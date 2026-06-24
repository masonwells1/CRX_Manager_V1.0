import { useState } from 'react';
import { LocateFixed, Loader2 } from 'lucide-react';

interface LocateMeProps {
  onLocate: (longitude: number, latitude: number) => void;
}

export default function LocateMe({ onLocate }: LocateMeProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLocate = () => {
    if (!navigator.geolocation) { setError('Location is not available on this device.'); return; }
    setLoading(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        onLocate(position.coords.longitude, position.coords.latitude);
        setLoading(false);
      },
      () => { setLoading(false); setError("Couldn't get your location - check the location permission for this site."); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  return (
    <div className="absolute top-4 left-4 z-10">
      <button
        type="button"
        onClick={handleLocate}
        disabled={loading}
        aria-label="Locate me"
        title="Center map on your location"
        className="bg-white rounded-lg shadow-md p-2.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
      >
        {loading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <LocateFixed className="w-5 h-5" />
        )}
      </button>
      {error && (
        <div className="mt-1 max-w-[200px] rounded-md bg-white shadow-md px-2 py-1 text-xs text-red-600">{error}</div>
      )}
    </div>
  );
}
