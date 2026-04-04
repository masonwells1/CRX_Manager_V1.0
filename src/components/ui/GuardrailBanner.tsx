import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { GuardrailWarning } from '../../hooks/useGuardrails';

interface GuardrailBannerProps {
  warning: GuardrailWarning | null;
  onDismiss: () => void;
  dismissLabel?: string;
}

export default function GuardrailBanner({ warning, onDismiss, dismissLabel = 'Continue Anyway' }: GuardrailBannerProps) {
  if (!warning || warning.dismissed) return null;

  const isDanger = warning.severity === 'danger';
  const bgClass = isDanger ? 'bg-orange-50 border-orange-200' : 'bg-amber-50 border-amber-200';
  const textClass = isDanger ? 'text-orange-800' : 'text-amber-800';
  const iconClass = isDanger ? 'text-orange-600' : 'text-amber-600';
  const btnClass = isDanger
    ? 'text-orange-700 hover:text-orange-900 hover:bg-orange-100'
    : 'text-amber-700 hover:text-amber-900 hover:bg-amber-100';
  const Icon = isDanger ? ShieldAlert : AlertTriangle;

  return (
    <div className={`border rounded-lg p-3 ${bgClass}`}>
      <div className="flex items-start gap-2">
        <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${iconClass}`} />
        <div className="flex-1 min-w-0">
          <p className={`text-sm ${textClass}`}>{warning.message}</p>
          <button
            type="button"
            onClick={onDismiss}
            className={`mt-1.5 text-xs font-medium px-2 py-1 rounded transition-colors ${btnClass}`}
          >
            {dismissLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
