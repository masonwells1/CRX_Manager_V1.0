// Field-app parity #16: "Attach Log Files" — upload / list / download / delete the
// log files (equipment/GPS coverage logs, PDFs, images) attached to ONE field job.
//
// All access is RLS-gated (job-scoped on job_attachments + path-scoped on the private
// job-attachments bucket). Uploader names are resolved via profile_public_view (never
// a direct profiles embed). Downloads use short-lived signed URLs (private bucket).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Paperclip, Download, Trash2, Upload, FileText } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import type { JobAttachment } from '../../types';
import {
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_ACCEPT,
  isAllowedAttachmentType,
  formatFileSize,
  formatUploadedAt,
} from '../../lib/jobAttachments';
import {
  listJobAttachments,
  uploadJobAttachment,
  getAttachmentDownloadUrl,
  deleteJobAttachment,
} from '../../lib/jobAttachmentsData';

interface JobAttachmentsProps {
  jobId: string;
  /** When false, hide upload/delete controls (caller cannot mutate). */
  canEdit?: boolean;
}

export default function JobAttachments({ jobId, canEdit = true }: JobAttachmentsProps) {
  const { toast } = useToast();
  const { profile, role } = useAuth();
  const isAdminOrSales = role === 'admin' || role === 'sales_rep';

  // Codex P3: the DELETE RLS lets admin/sales remove ANY file but an applicator only
  // files they uploaded. Mirror that in the UI so an applicator doesn't see a trash
  // button that always 403s on someone else's upload.
  const canDeleteRow = (a: JobAttachment): boolean =>
    canEdit && (isAdminOrSales || (!!profile && a.uploaded_by === profile.id));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<JobAttachment[]>([]);
  const [uploaderNames, setUploaderNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<JobAttachment | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await listJobAttachments(jobId);
      setAttachments(rows);
      // Resolve uploader display names via profile_public_view (non-PII), not a profiles embed.
      const ids = [...new Set(rows.map((r) => r.uploaded_by).filter((x): x is string => !!x))];
      if (ids.length > 0) {
        const { data } = await supabase
          .from('profile_public_view')
          .select('id, full_name')
          .in('id', ids);
        const map: Record<string, string> = {};
        for (const p of (data ?? []) as Array<{ id: string; full_name: string | null }>) {
          map[p.id] = p.full_name || 'Unknown';
        }
        setUploaderNames(map);
      } else {
        setUploaderNames({});
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { source: 'fetch', action: 'list_job_attachments' },
      });
      toast('error', 'Failed to load attachments. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [jobId, toast]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !profile) return;

    // Size + type gates before any upload (the bucket enforces both server-side too —
    // these just fail fast with a clear message instead of a raw Storage 4xx).
    for (const f of Array.from(files)) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        toast('error', `"${f.name}" exceeds the ${formatFileSize(MAX_ATTACHMENT_BYTES)} limit`);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
      if (!isAllowedAttachmentType(f.type)) {
        toast('error', `"${f.name}" is not an accepted file type (PDF, image, CSV/text, KML/GPX, or ZIP).`);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
    }

    setUploading(true);
    let ok = 0;
    for (const file of Array.from(files)) {
      try {
        await uploadJobAttachment({
          jobId,
          file,
          uploaderId: profile.id,
          uuid: crypto.randomUUID(),
        });
        ok += 1;
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
          extra: { context: 'Upload job attachment' },
        });
        toast('error', `Upload failed for "${file.name}".`);
      }
    }
    if (ok > 0) {
      toast('success', `${ok} file${ok > 1 ? 's' : ''} attached`);
      await refresh();
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDownload = async (a: JobAttachment) => {
    setBusyId(a.id);
    // Open the tab SYNCHRONOUSLY inside the click handler so the awaited signed-URL
    // request doesn't consume the user activation (mobile Safari / slow field
    // connections block a popup opened after an await). We must NOT pass `noopener`
    // here — that makes window.open return null so we'd lose the handle — so we open a
    // plain tab and sever the opener ourselves once we navigate it (Codex P2).
    const newTab = window.open('about:blank', '_blank');
    if (newTab) newTab.opener = null; // no reverse access to this app from the new tab
    try {
      const url = await getAttachmentDownloadUrl(a.storage_path, 60);
      if (newTab && !newTab.closed) {
        newTab.location.replace(url);
      } else {
        // Popup was blocked (no handle) — tell the user rather than hijacking this tab.
        toast('error', 'Your browser blocked the download tab. Allow pop-ups for this site and try again.');
      }
    } catch (err) {
      if (newTab && !newTab.closed) newTab.close();
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        extra: { context: 'Download job attachment' },
      });
      toast('error', 'Could not open that attachment. Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (a: JobAttachment) => {
    setBusyId(a.id);
    try {
      await deleteJobAttachment(a);
      toast('success', 'Attachment deleted');
      await refresh();
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        extra: { context: 'Delete job attachment' },
      });
      toast('error', 'Could not delete that attachment. You may not have permission.');
    } finally {
      setBusyId(null);
      setConfirmDelete(null);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-nav-dark flex items-center gap-2">
          <Paperclip className="w-5 h-5 text-crx-green" />
          Attached Log Files ({attachments.length})
        </h2>
        {canEdit && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              className="hidden"
              aria-label="Attach log files"
              accept={ATTACHMENT_ACCEPT}
            />
            <Button
              variant="secondary"
              onClick={() => fileInputRef.current?.click()}
              loading={uploading}
              showChevron={false}
            >
              <Upload className="w-4 h-4 mr-1.5" />
              Attach Files
            </Button>
          </>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500 py-6 text-center">Loading attachments…</p>
      ) : attachments.length === 0 ? (
        <div className="text-center py-10 text-gray-500">
          <FileText className="w-10 h-10 mx-auto mb-2 text-gray-300" />
          <p className="text-sm">No log files attached to this job yet.</p>
          {canEdit && (
            <p className="text-xs mt-1">
              Attach GPS/coverage logs, application records, maps, or any proof document.
            </p>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-2 pr-3 font-medium">File</th>
                <th className="py-2 px-3 font-medium">Size</th>
                <th className="py-2 px-3 font-medium">Uploaded</th>
                <th className="py-2 px-3 font-medium">By</th>
                <th className="py-2 pl-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {attachments.map((a) => (
                <tr key={a.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-2 text-nav-dark">
                      <FileText className="w-4 h-4 text-gray-400 shrink-0" />
                      <span className="truncate max-w-[16rem]" title={a.file_name}>
                        {a.file_name}
                      </span>
                    </span>
                  </td>
                  <td className="py-2 px-3 text-gray-600 whitespace-nowrap">{formatFileSize(a.file_size)}</td>
                  <td className="py-2 px-3 text-gray-600 whitespace-nowrap">{formatUploadedAt(a.uploaded_at)}</td>
                  <td className="py-2 px-3 text-gray-600 whitespace-nowrap">
                    {a.uploaded_by ? uploaderNames[a.uploaded_by] || '…' : '—'}
                  </td>
                  <td className="py-2 pl-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleDownload(a)}
                        disabled={busyId === a.id}
                        title="Download"
                        aria-label={`Download ${a.file_name}`}
                        className="p-1.5 text-secondary hover:text-crx-green disabled:opacity-40 transition-colors"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                      {canDeleteRow(a) && (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(a)}
                          disabled={busyId === a.id}
                          title="Delete"
                          aria-label={`Delete ${a.file_name}`}
                          className="p-1.5 text-secondary hover:text-red-600 disabled:opacity-40 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDelete(confirmDelete)}
        title="Delete attachment?"
        message={`Permanently delete "${confirmDelete?.file_name}"? This removes the file and cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
      />
    </Card>
  );
}
