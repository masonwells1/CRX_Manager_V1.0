import { useState } from 'react';
import { Layers, Satellite, Map as MapIcon, Mountain } from 'lucide-react';
import type { BaseLayerType } from './CRXMap';

interface LayerToggleProps {
  activeLayer: BaseLayerType;
  onChange: (layer: BaseLayerType) => void;
}

const LAYER_OPTIONS: { key: BaseLayerType; label: string; Icon: typeof Satellite }[] = [
  { key: 'satellite', label: 'Satellite', Icon: Satellite },
  { key: 'roads', label: 'Roads', Icon: MapIcon },
  { key: 'hybrid', label: 'Hybrid', Icon: Layers },
  { key: 'terrain', label: 'Terrain', Icon: Mountain },
];

export default function LayerToggle({ activeLayer, onChange }: LayerToggleProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="absolute bottom-4 left-4 z-10">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="bg-white rounded-lg shadow-md px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 flex items-center gap-2"
      >
        <Layers className="w-4 h-4" />
        {LAYER_OPTIONS.find((l) => l.key === activeLayer)?.label ?? 'Satellite'}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 bg-white rounded-lg shadow-lg border p-1 min-w-[140px]">
          {LAYER_OPTIONS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                onChange(key);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 rounded text-sm flex items-center gap-2 ${
                key === activeLayer
                  ? 'bg-crx-green/10 text-crx-green font-medium'
                  : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
