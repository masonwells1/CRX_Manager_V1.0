import { useState } from 'react';
import { LocateFixed, Loader2 } from 'lucide-react';

interface LocateMeProps {
  onLocate: (longitude: number, latitude: number) => void;
}

export default function LocateMe({ onLocate }: LocateMeProps) {
  const [loading, setLoading] = useState(false);

  const handleLocate = () => {
    if (!navigator.geolocation) return;
    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        onLocate(position.coords.longitude, position.coords.latitude);
        setLoading(false);
      },
      () => setLoading(false),
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
    </div>
  );
}
