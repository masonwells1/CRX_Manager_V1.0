import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CircleDot,
  RadioTower,
  TreePine,
  Waves,
  Wind,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Marker, Popup } from 'react-map-gl/mapbox';
import { FIELD_OBSTACLE_KIND_LABELS, fieldObstacleToGeoJsonFeature } from '../../lib/fieldObstacles';
import type { FieldObstacle, FieldObstacleKind } from '../../types';

const OBSTACLE_ICONS: Record<FieldObstacleKind, LucideIcon> = {
  oil_well: CircleDot,
  windmill: Wind,
  tower: RadioTower,
  tree_line: TreePine,
  power_line: Zap,
  waterway: Waves,
  other: AlertTriangle,
};

interface FieldObstacleLayerProps {
  obstacles: FieldObstacle[];
  interactive?: boolean;
}

export default function FieldObstacleLayer({
  obstacles,
  interactive = true,
}: FieldObstacleLayerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const markers = useMemo(
    () => obstacles.flatMap((obstacle) => {
      const feature = fieldObstacleToGeoJsonFeature(obstacle);
      return feature ? [{ obstacle, feature }] : [];
    }),
    [obstacles],
  );
  const selected = markers.find(({ obstacle }) => obstacle.id === selectedId) ?? null;

  if (markers.length === 0) return null;

  return (
    <>
      {markers.map(({ obstacle, feature }) => {
        const Icon = OBSTACLE_ICONS[obstacle.kind];
        return (
          <Marker
            key={obstacle.id}
            longitude={feature.geometry.coordinates[0]}
            latitude={feature.geometry.coordinates[1]}
            anchor="center"
            style={{ pointerEvents: interactive ? 'auto' : 'none' }}
            onClick={interactive ? (event) => {
              event.originalEvent.stopPropagation();
              setSelectedId(obstacle.id);
            } : undefined}
          >
            <div
              title={feature.properties.title}
              aria-label={feature.properties.title}
              className={`flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-red-600 text-white shadow-md ${
                interactive ? 'cursor-pointer transition-transform hover:scale-110' : 'pointer-events-none'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
            </div>
          </Marker>
        );
      })}

      {interactive && selected && (
        <Popup
          longitude={selected.feature.geometry.coordinates[0]}
          latitude={selected.feature.geometry.coordinates[1]}
          anchor="bottom"
          offset={16}
          closeButton
          closeOnClick={false}
          onClose={() => setSelectedId(null)}
        >
          <div className="space-y-0.5 px-1 py-1 text-xs">
            <p className="font-semibold text-nav-dark">{selected.feature.properties.label}</p>
            <p className="text-secondary">{FIELD_OBSTACLE_KIND_LABELS[selected.obstacle.kind]}</p>
          </div>
        </Popup>
      )}
    </>
  );
}
