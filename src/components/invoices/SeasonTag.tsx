import Badge from '../ui/Badge';
import { otherSeasonLabel } from '../../lib/invoiceSeasonWindow';

/**
 * Small "Season 2026" pill for an invoice filed in a season other than the current
 * one. Invoice lists show open invoices from every season, so this keeps a
 * prior-season draft or unpaid invoice recognisable. Renders nothing for the
 * current season.
 */
export default function SeasonTag({ season }: { season: number | null | undefined }) {
  const label = otherSeasonLabel(season);
  if (!label) return null;
  return (
    <Badge variant="warning" size="sm" className="whitespace-nowrap">
      {label}
    </Badge>
  );
}
