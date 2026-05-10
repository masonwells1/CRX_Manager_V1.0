import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { runReconciliationChecks, type ReconciliationReport } from '../lib/reconciliation';
import { useToast } from '../components/ui/Toast';

export default function IntegrityReport() {
  const { toast } = useToast();
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchReport = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await runReconciliationChecks();
      setReport(result);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Reconciliation failed');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-gray-600">Running integrity checks…</div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="p-6">
        <div className="text-red-600">Failed to load report.</div>
      </div>
    );
  }

  const allPassed = report.totalDiscrepancies === 0;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            {allPassed ? (
              <ShieldCheck className="w-8 h-8 text-crx-green" />
            ) : (
              <ShieldAlert className="w-8 h-8 text-amber-600" />
            )}
            <h1 className="text-2xl font-semibold text-gray-900">Integrity Report</h1>
          </div>
          <p className="text-sm text-gray-600 mt-2">
            Cross-entity reconciliation checks comparing related tables for drift.
            Any discrepancy is a sign that two source-of-truth values disagree —
            usually due to a bug, manual edit, or interrupted operation.
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Run at {new Date(report.timestamp).toLocaleString()} ·
            {' '}{report.checks.length} checks ·
            {' '}<span className={allPassed ? 'text-crx-green font-medium' : 'text-amber-600 font-medium'}>
              {report.totalDiscrepancies} discrepanc{report.totalDiscrepancies === 1 ? 'y' : 'ies'}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={fetchReport}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Running…' : 'Re-run'}
        </button>
      </div>

      <div className="space-y-4">
        {report.checks.map((check) => (
          <div
            key={check.name}
            className={`border rounded-lg p-4 ${
              check.passed ? 'border-gray-200 bg-white' : 'border-amber-300 bg-amber-50'
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  {check.passed ? (
                    <CheckCircle2 className="w-5 h-5 text-crx-green flex-shrink-0" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                  )}
                  <h2 className="font-medium text-gray-900">{check.name}</h2>
                  <span className="text-xs text-gray-500">
                    ({check.entitiesChecked} entit{check.entitiesChecked === 1 ? 'y' : 'ies'} checked)
                  </span>
                </div>
                <p className="text-sm text-gray-600 mt-1 ml-7">{check.description}</p>
              </div>
              <span className={`text-sm font-medium ${
                check.passed ? 'text-crx-green' : 'text-amber-700'
              }`}>
                {check.passed
                  ? 'PASS'
                  : `${check.discrepancies.length} issue${check.discrepancies.length === 1 ? '' : 's'}`}
              </span>
            </div>

            {check.discrepancies.length > 0 && (
              <div className="mt-3 ml-7">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200">
                      <th className="py-2 pr-4 font-medium">Entity</th>
                      <th className="py-2 pr-4 font-medium">Expected</th>
                      <th className="py-2 pr-4 font-medium">Actual</th>
                      <th className="py-2 pr-4 font-medium">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {check.discrepancies.slice(0, 50).map((d, i) => (
                      <tr key={`${d.entityId}-${i}`} className="border-b border-amber-200 last:border-b-0">
                        <td className="py-2 pr-4 font-mono text-xs text-gray-700">{d.entity}</td>
                        <td className="py-2 pr-4 text-gray-700">{d.expected.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-gray-700">{d.actual.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-amber-700 font-medium">{d.delta.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {check.discrepancies.length > 50 && (
                  <p className="text-xs text-gray-500 mt-2">
                    Showing first 50 of {check.discrepancies.length} discrepancies.
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="text-xs text-gray-500 pt-4 border-t border-gray-200">
        <p>
          <strong>How to read this report:</strong> Each check compares one source of truth against
          another. A discrepancy means the two values disagree — investigate before assuming the
          system state is correct. Money values are in cents.
        </p>
        <p className="mt-2">
          <strong>Recommended cadence:</strong> run before month-end close (per the
          {' '}<a href="/docs/operations/production-runbook.md" className="underline">production runbook</a>),
          and any time a customer reports a balance that doesn't match their statement.
        </p>
      </div>
    </div>
  );
}
