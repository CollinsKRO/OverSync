import { useState } from 'react';
import { FileDown } from 'lucide-react';
import { buildEvidenceData, downloadEvidenceJson } from '../lib/evidence';

const STORAGE_KEY = 'oversync_transactions_v2';

/**
 * Read the locally-persisted orders that should be included in the evidence
 * export. These are the same objects the UI already holds; they are passed
 * through the coordinator's public field set by `buildEvidenceData`, which
 * refuses (rather than strips) any object that still carries a preimage.
 */
function readLocalOrders(): unknown[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function EvidenceExportAction() {
  const [error, setError] = useState<string | null>(null);

  const handleExport = () => {
    try {
      const data = buildEvidenceData(readLocalOrders());
      downloadEvidenceJson(data);
      setError(null);
    } catch (err) {
      // A local order still carried a preimage (or another secret field).
      // Refuse the export instead of silently stripping it in the browser.
      setError(err instanceof Error ? err.message : 'Evidence export refused');
    }
  };

  return (
    <div className="max-w-2xl">
      <button
        onClick={handleExport}
        className="button-hover-scale inline-flex items-center gap-2 rounded-full border border-cyan-200/20 bg-white/[0.045] px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-cyan-200/40 hover:bg-cyan-200/10 hover:text-white"
      >
        <FileDown className="h-4 w-4" />
        Export evidence JSON
      </button>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
        Download public proof points (contracts, coverage, mode, order ids and transaction hashes) for reviewer follow-up. No secrets or wallet addresses.
      </p>
      {error && (
        <p role="alert" className="mt-1.5 text-xs leading-relaxed text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}
