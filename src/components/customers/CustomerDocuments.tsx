import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { AlertTriangle, Download, FileText, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { checkMutationResult, supabase, supabaseUntyped } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useToast } from '../ui/Toast';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';
import ConfirmModal from '../ui/ConfirmModal';
import Input from '../ui/Input';

const DOCUMENT_BUCKET = 'customer-documents';
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
const DOCUMENT_TYPES = ['license', 'permit', 'contract', 'map', 'invoice_copy', 'other'] as const;

type DocumentType = (typeof DOCUMENT_TYPES)[number];
type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

interface CustomerDocumentRow {
  id: string;
  customer_id: string;
  document_type: DocumentType;
  storage_path: string;
  filename: string;
  mime_type: AllowedMimeType;
  size_bytes: number;
  effective_date: string | null;
  expiration_date: string | null;
  notes: string | null;
  created_at: string;
}

interface CustomerDocumentsProps {
  customerId: string;
}

const errorMessage = (error: unknown, fallback: string) => (
  error instanceof Error && error.message ? error.message : fallback
);

function formatDate(value: string | null, dateOnly = false): string {
  if (!value) return '—';
  const parsed = dateOnly ? new Date(`${value}T00:00:00`) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeFilename(filename: string): string {
  const sanitized = filename
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180);
  return sanitized || 'document';
}

function expirationStatus(expirationDate: string | null): 'expired' | 'soon' | null {
  if (!expirationDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiration = new Date(`${expirationDate}T00:00:00`);
  const daysUntil = Math.ceil((expiration.getTime() - today.getTime()) / 86_400_000);
  if (daysUntil < 0) return 'expired';
  if (daysUntil <= 30) return 'soon';
  return null;
}

function isAllowedMimeType(value: string): value is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(value);
}

export default function CustomerDocuments({ customerId }: CustomerDocumentsProps) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [documents, setDocuments] = useState<CustomerDocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [assignedSalesRep, setAssignedSalesRep] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState<DocumentType>('other');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [documentToDelete, setDocumentToDelete] = useState<CustomerDocumentRow | null>(null);
  const requestSeq = useRef(0);

  const loadDocuments = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(false);
    try {
      const [documentResult, customerResult] = await Promise.all([
        supabaseUntyped
          .from('customer_documents')
          .select('id, customer_id, document_type, storage_path, filename, mime_type, size_bytes, effective_date, expiration_date, notes, created_at')
          .eq('customer_id', customerId)
          .is('deleted_at', null)
          .order('expiration_date', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: false }),
        supabase
          .from('customers')
          .select('assigned_sales_rep')
          .eq('id', customerId)
          .maybeSingle(),
      ]);

      if (seq !== requestSeq.current) return;
      if (documentResult.error) throw documentResult.error;
      if (customerResult.error) throw customerResult.error;

      // Local cast until the mid-gauntlet customer_documents migration is included in
      // src/types/supabase.ts; remove this cast after schema-registry regeneration.
      setDocuments((documentResult.data ?? []) as unknown as CustomerDocumentRow[]);
      setAssignedSalesRep((customerResult.data as { assigned_sales_rep: string | null } | null)?.assigned_sales_rep ?? null);
    } catch (error: unknown) {
      if (seq !== requestSeq.current) return;
      setDocuments([]);
      setLoadError(true);
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        extra: { context: 'CustomerDocuments.load' },
      });
      toast('error', errorMessage(error, 'Failed to load customer documents'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [customerId, toast]);

  useEffect(() => {
    setDocuments([]);
    setAssignedSalesRep(null);
    void loadDocuments();
  }, [loadDocuments]);

  const canDelete = profile?.role === 'admin'
    || (profile?.role === 'sales_rep' && assignedSalesRep === profile.id);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (!isAllowedMimeType(file.type)) {
      setSelectedFile(null);
      event.target.value = '';
      toast('error', 'Choose a PDF, JPEG, PNG, or WebP file.');
      return;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setSelectedFile(null);
      event.target.value = '';
      toast('error', 'Documents must be 20 MB or smaller.');
      return;
    }
    setSelectedFile(file);
  };

  const currentUserId = async (): Promise<string> => {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    if (!data.user) throw new Error('Your session has expired. Please sign in again.');
    return data.user.id;
  };

  const handleUpload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedFile) {
      toast('error', 'Choose a document before uploading.');
      return;
    }
    if (!isAllowedMimeType(selectedFile.type) || selectedFile.size > MAX_FILE_SIZE_BYTES) {
      toast('error', 'Choose a PDF, JPEG, PNG, or WebP file up to 20 MB.');
      return;
    }
    if (effectiveDate && expirationDate && expirationDate < effectiveDate) {
      toast('error', 'Expiration date cannot be before the effective date.');
      return;
    }

    setSaving(true);
    const storagePath = `${customerId}/${crypto.randomUUID()}-${sanitizeFilename(selectedFile.name)}`;
    try {
      const { error: uploadError } = await supabase.storage
        .from(DOCUMENT_BUCKET)
        .upload(storagePath, selectedFile, { contentType: selectedFile.type, upsert: false });
      if (uploadError) throw uploadError;

      try {
        const insertResult = await supabaseUntyped
          .from('customer_documents')
          .insert({
            customer_id: customerId,
            document_type: documentType,
            storage_path: storagePath,
            filename: selectedFile.name,
            mime_type: selectedFile.type,
            size_bytes: selectedFile.size,
            uploaded_by: await currentUserId(),
            source: 'rep',
            effective_date: effectiveDate || null,
            expiration_date: expirationDate || null,
            notes: notes.trim() || null,
          })
          .select()
          .single();
        checkMutationResult(insertResult, 'Save customer document');
      } catch (insertError: unknown) {
        await supabase.storage.from(DOCUMENT_BUCKET).remove([storagePath]);
        throw insertError;
      }

      toast('success', 'Document uploaded');
      setSelectedFile(null);
      setDocumentType('other');
      setEffectiveDate('');
      setExpirationDate('');
      setNotes('');
      await loadDocuments();
    } catch (error: unknown) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        extra: { context: 'CustomerDocuments.upload' },
      });
      toast('error', errorMessage(error, 'Failed to upload document'));
    } finally {
      setSaving(false);
    }
  };

  const handleDownload = async (document: CustomerDocumentRow) => {
    setDownloadingId(document.id);
    try {
      const { data, error } = await supabase.storage
        .from(DOCUMENT_BUCKET)
        .createSignedUrl(document.storage_path, 60);
      if (error) throw error;
      if (!data?.signedUrl) throw new Error('Could not create a download link.');
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (error: unknown) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        extra: { context: 'CustomerDocuments.download', documentId: document.id },
      });
      toast('error', errorMessage(error, 'Failed to prepare document download'));
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async () => {
    if (!documentToDelete) return;
    setDeletingId(documentToDelete.id);
    try {
      const deletedBy = await currentUserId();
      const updateResult = await supabaseUntyped
        .from('customer_documents')
        .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
        .eq('id', documentToDelete.id)
        .eq('customer_id', customerId)
        .is('deleted_at', null)
        .select();
      checkMutationResult(updateResult, 'Remove customer document');
      setDocuments((current) => current.filter((document) => document.id !== documentToDelete.id));
      toast('success', 'Document removed');
      setDocumentToDelete(null);
    } catch (error: unknown) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        extra: { context: 'CustomerDocuments.delete', documentId: documentToDelete.id },
      });
      toast('error', errorMessage(error, 'Failed to remove document'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Add" accent="Document" />
        <form className="space-y-4" onSubmit={(event) => void handleUpload(event)}>
          <div>
            <label htmlFor="customer-document-file" className="mb-1 block text-sm font-medium text-secondary">File</label>
            <input
              id="customer-document-file"
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
              className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-nav-dark file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-1 file:text-sm"
            />
            <p className="mt-1 text-xs text-secondary">PDF, JPEG, PNG, or WebP up to 20 MB.</p>
            {selectedFile && <p className="mt-1 text-sm text-nav-dark">Selected: {selectedFile.name} ({formatBytes(selectedFile.size)})</p>}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="customer-document-type" className="mb-1 block text-sm font-medium text-secondary">Document type</label>
              <select id="customer-document-type" value={documentType} onChange={(event) => setDocumentType(event.target.value as DocumentType)} className="min-h-11 w-full rounded-lg border border-gray-300 px-3 text-sm text-nav-dark">
                {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{type.replace('_', ' ')}</option>)}
              </select>
            </div>
            <Input label="Effective date" type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} />
            <Input label="Expiration date" type="date" value={expirationDate} onChange={(event) => setExpirationDate(event.target.value)} />
          </div>
          <div>
            <label htmlFor="customer-document-notes" className="mb-1 block text-sm font-medium text-secondary">Notes <span className="font-normal">(optional)</span></label>
            <textarea id="customer-document-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-nav-dark focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20" />
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={saving} disabled={!selectedFile} icon={<Upload className="h-4 w-4" />} showChevron={false} className="min-h-11">Upload document</Button>
          </div>
        </form>
      </Card>

      <Card padding={false}>
        <div className="flex items-center justify-between gap-3 p-4 sm:p-5">
          <CardHeader title="Customer" accent="Documents" />
          <Button type="button" variant="ghost" size="sm" icon={<RefreshCw className="h-4 w-4" />} showChevron={false} onClick={() => void loadDocuments()} className="min-h-11">Refresh</Button>
        </div>
        {loading ? (
          <div className="space-y-3 px-4 pb-5 sm:px-5">
            {[1, 2, 3].map((item) => <div key={item} className="h-28 animate-pulse rounded-lg bg-gray-100" />)}
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-3 px-4 pb-5 text-center sm:px-5">
            <p className="text-sm text-secondary">We couldn&apos;t load this customer&apos;s documents.</p>
            <Button type="button" variant="secondary" size="sm" icon={<RefreshCw className="h-4 w-4" />} showChevron={false} onClick={() => void loadDocuments()} className="min-h-11">Try again</Button>
          </div>
        ) : documents.length === 0 ? (
          <div className="px-4 pb-5 text-sm text-secondary sm:px-5">No documents have been uploaded yet.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {documents.map((document) => {
              const status = expirationStatus(document.expiration_date);
              return (
                <div key={document.id} className="p-4 sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 gap-3">
                      <FileText className="mt-0.5 h-5 w-5 shrink-0 text-crx-green" />
                      <div className="min-w-0">
                        <p className="break-words font-medium text-nav-dark">{document.filename}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <Badge variant="info">{document.document_type.replace('_', ' ')}</Badge>
                          {status === 'soon' && <Badge variant="warning"><AlertTriangle className="mr-1 h-3 w-3" />Expiring soon</Badge>}
                          {status === 'expired' && <Badge variant="expired">Expired</Badge>}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button type="button" variant="secondary" size="sm" loading={downloadingId === document.id} icon={<Download className="h-4 w-4" />} showChevron={false} onClick={() => void handleDownload(document)} className="min-h-11">Download</Button>
                      {canDelete && <Button type="button" variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" />} showChevron={false} onClick={() => setDocumentToDelete(document)} aria-label={`Remove ${document.filename}`} className="min-h-11 text-red-600 hover:text-red-700">Remove</Button>}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-secondary sm:grid-cols-4">
                    <div><span className="block font-medium text-nav-dark">Effective</span>{formatDate(document.effective_date, true)}</div>
                    <div><span className="block font-medium text-nav-dark">Expires</span>{formatDate(document.expiration_date, true)}</div>
                    <div><span className="block font-medium text-nav-dark">Size</span>{formatBytes(document.size_bytes)}</div>
                    <div><span className="block font-medium text-nav-dark">Uploaded</span>{formatDate(document.created_at)}</div>
                  </div>
                  {document.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-secondary">{document.notes}</p>}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <ConfirmModal
        open={Boolean(documentToDelete)}
        onClose={() => { if (!deletingId) setDocumentToDelete(null); }}
        onConfirm={() => void handleDelete()}
        title="Remove document"
        message={`Remove ${documentToDelete?.filename || 'this document'} from the customer record? The file will remain in storage and this record will be hidden.`}
        confirmLabel="Remove document"
        variant="danger"
        loading={Boolean(deletingId)}
      />
    </div>
  );
}
