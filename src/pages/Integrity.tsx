import { useSearchParams } from 'react-router-dom';
import IntegrityReportPanel from '../components/integrity/IntegrityReportPanel';
import IntegrityCleanupPanel from '../components/integrity/IntegrityCleanupPanel';
import Tabs, { type TabItem } from '../components/ui/Tabs';

type IntegrityTab = 'report' | 'cleanup';

const TAB_ALIASES: Record<string, IntegrityTab> = {
  report: 'report',
  checks: 'report',
  cleanup: 'cleanup',
};

/**
 * Single admin surface for read-only reconciliation and action-driven cleanup.
 * Each original page body stays independently mounted as a tab panel so its
 * queries, safeguards, and repair actions remain unchanged.
 */
export default function Integrity() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = TAB_ALIASES[searchParams.get('tab') ?? 'report'] ?? 'report';

  const tabs: TabItem[] = [
    { key: 'report', label: 'Report', content: <IntegrityReportPanel /> },
    { key: 'cleanup', label: 'Cleanup', content: <IntegrityCleanupPanel /> },
  ];

  const handleTabChange = (tab: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    setSearchParams(params);
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold font-heading text-nav-dark">Data Integrity</h1>
        <p className="mt-1 text-sm text-secondary">
          Review reconciliation checks and resolve data conditions that need attention.
        </p>
      </div>

      <Tabs
        tabs={tabs}
        activeKey={activeTab}
        onChange={handleTabChange}
        ariaLabel="Data integrity workflow"
      />
    </div>
  );
}
