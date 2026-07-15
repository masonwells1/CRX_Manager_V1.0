import { useEffect, useState, useRef } from 'react';
import { Upload, X, Image as ImageIcon, AlertCircle } from 'lucide-react';
import Button from '../ui/Button';
import Card from '../ui/Card';
import Input from '../ui/Input';
import { supabase, assertRpcResult } from '../../lib/db';
import { useAuth } from '../../contexts/AuthContext';
import { compressImage } from '../../lib/imageCompression';
import { localToday } from '../../lib/dateUtils';
import { Sentry } from '../../lib/sentry';
import type { Customer } from '../../types';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';

interface ImageFile {
  file: File;
  preview: string;
  id: string;
}

interface BulkTicketUploadProps {
  customers: Customer[];
  onUploadComplete: () => void;
}

interface PersistedUncertainUpload {
  version: 1;
  userId: string;
  ticketId: string;
  idempotencyKey: string;
  expiresAt: number;
  ticketPayload: {
    customer_id: string | null;
    ticket_date: string | null;
    driver_name: string | null;
    tank_number: string | null;
  };
  images: Array<{
    storage_path: string;
    file_size: number;
    mime_type: string;
    upload_order: number;
  }>;
}

const UNCERTAIN_UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const uncertainUploadStorageKey = (userId: string) => `crx:blend-ticket-upload:uncertain:v1:${userId}`;

function readPersistedUncertainUpload(userId: string): PersistedUncertainUpload | null {
  try {
    const key = uncertainUploadStorageKey(userId);
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedUncertainUpload>;
    const ticketId = typeof value.ticketId === 'string' ? value.ticketId : '';
    const images = Array.isArray(value.images) ? value.images : [];
    const valid = value.version === 1
      && value.userId === userId
      && ticketId.length <= 64
      && typeof value.idempotencyKey === 'string'
      && value.idempotencyKey.length > 0
      && value.idempotencyKey.length <= 256
      && typeof value.expiresAt === 'number'
      && value.expiresAt > Date.now()
      && typeof value.ticketPayload === 'object'
      && value.ticketPayload !== null
      && images.length > 0
      && images.length <= 20
      && images.every((image) => image
        && typeof image.storage_path === 'string'
        && image.storage_path.startsWith(`${ticketId}/`)
        && image.storage_path.length <= 160
        && Number.isInteger(image.file_size)
        && image.file_size >= 1
        && image.file_size <= 10 * 1024 * 1024
        && ['image/jpeg', 'image/png', 'image/webp'].includes(image.mime_type)
        && Number.isInteger(image.upload_order)
        && image.upload_order >= 1
        && image.upload_order <= 20);
    if (!valid) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return value as PersistedUncertainUpload;
  } catch {
    return null;
  }
}

export function BulkTicketUpload({ customers, onUploadComplete }: BulkTicketUploadProps) {
  const { profile } = useAuth();
  const { getKey: getUploadKey, resetKey: resetUploadKey } = useIdempotencyKey(
    'create_blend_ticket',
    profile?.id || '',
  );
  const ticketAttemptIdRef = useRef<string | null>(null);
  const commitMayHaveOccurredRef = useRef(false);
  const persistedAttemptRef = useRef<PersistedUncertainUpload | null>(null);
  const loadedUserIdRef = useRef<string | null | undefined>(undefined);
  const [attemptUncertain, setAttemptUncertain] = useState(false);
  const [images, setImages] = useState<ImageFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [ticketDate, setTicketDate] = useState<string>(localToday());
  const [driverName, setDriverName] = useState('');
  const [tankNumber, setTankNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const clearPersistedAttempt = () => {
    persistedAttemptRef.current = null;
    if (!profile?.id) return;
    try {
      window.sessionStorage.removeItem(uncertainUploadStorageKey(profile.id));
    } catch {
      // Storage is a best-effort reload guard; in-memory reconciliation remains active.
    }
  };

  const persistUncertainAttempt = (attempt: PersistedUncertainUpload) => {
    persistedAttemptRef.current = attempt;
    try {
      window.sessionStorage.setItem(uncertainUploadStorageKey(attempt.userId), JSON.stringify(attempt));
    } catch {
      // Quota/privacy settings must not interrupt the upload. The current mount
      // still retains the exact intent in memory.
    }
  };

  useEffect(() => {
    const userId = profile?.id || null;
    const isFirstUserLoad = loadedUserIdRef.current === undefined;
    const userChanged = !isFirstUserLoad && loadedUserIdRef.current !== userId;
    loadedUserIdRef.current = userId;

    if (userChanged) {
      persistedAttemptRef.current = null;
      ticketAttemptIdRef.current = null;
      commitMayHaveOccurredRef.current = false;
      resetUploadKey();
      setImages((previous) => {
        previous.forEach((image) => URL.revokeObjectURL(image.preview));
        return [];
      });
      setSelectedCustomerId('');
      setTicketDate(localToday());
      setDriverName('');
      setTankNumber('');
      setAttemptUncertain(false);
      setUploadProgress(0);
      setError(null);
    }
    if (!userId) return;
    const persisted = readPersistedUncertainUpload(userId);
    if (!persisted) return;
    persistedAttemptRef.current = persisted;
    ticketAttemptIdRef.current = persisted.ticketId;
    commitMayHaveOccurredRef.current = true;
    setSelectedCustomerId(persisted.ticketPayload.customer_id || '');
    setTicketDate(persisted.ticketPayload.ticket_date || localToday());
    setDriverName(persisted.ticketPayload.driver_name || '');
    setTankNumber(persisted.ticketPayload.tank_number || '');
    setAttemptUncertain(true);
    setError('A previous upload may have completed. Check its status before starting another upload.');
  }, [profile?.id, resetUploadKey]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isUploading || attemptUncertain) return;
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      handleFiles(files);
    }
  };

  const MAX_IMAGES = 20;
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  const handleFiles = (files: File[]) => {
    if (isUploading || attemptUncertain) return;
    const validFiles = files.filter(file => {
      if (!ALLOWED_TYPES.includes(file.type)) {
        setError('Only JPEG, PNG, and WebP images are allowed');
        return false;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError('Files must be smaller than 10MB');
        return false;
      }
      return true;
    });

    if (images.length + validFiles.length > MAX_IMAGES) {
      setError(`Maximum ${MAX_IMAGES} images per upload. You have ${images.length} selected and tried to add ${validFiles.length} more.`);
      return;
    }

    const newImages: ImageFile[] = validFiles.map(file => ({
      file,
      preview: URL.createObjectURL(file),
      id: Math.random().toString(36).substr(2, 9),
    }));

    setImages(prev => [...prev, ...newImages]);
    setError(null);
  };

  const removeImage = (id: string) => {
    if (isUploading || attemptUncertain) return;
    setImages(prev => {
      const removed = prev.find(img => img.id === id);
      if (removed) {
        URL.revokeObjectURL(removed.preview);
      }
      return prev.filter(img => img.id !== id);
    });
  };

  const finishCommittedUpload = (ticketId: string) => {
    // Trigger server-side OCR processing via Edge Function (non-blocking).
    // Supabase may resolve failures as { error } instead of rejecting.
    void supabase.functions.invoke('process-blend-ticket', {
      body: { blend_ticket_id: ticketId },
    }).then(({ error: invokeError }) => {
      if (invokeError) throw invokeError;
    }).catch((err) => {
      // Non-fatal: the fallback polling in useOCRProcessor will pick it up.
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        {
          level: 'warning',
          extra: { context: 'Edge Function trigger failed — will retry via polling' },
        },
      );
    });

    resetUploadKey();
    clearPersistedAttempt();
    ticketAttemptIdRef.current = null;
    commitMayHaveOccurredRef.current = false;
    setAttemptUncertain(false);
    images.forEach(img => URL.revokeObjectURL(img.preview));
    setImages([]);
    setSelectedCustomerId('');
    setTicketDate(localToday());
    setDriverName('');
    setTankNumber('');
    setUploadProgress(0);
    onUploadComplete();
    setError(null);
  };

  const handleUpload = async () => {
    const restoredAttempt = persistedAttemptRef.current;
    if (images.length === 0 && !restoredAttempt) {
      setError('Please select at least one image');
      return;
    }

    if (!profile) {
      setError('You must be logged in to upload');
      return;
    }

    const ticketId = restoredAttempt?.ticketId || ticketAttemptIdRef.current || crypto.randomUUID();
    ticketAttemptIdRef.current = ticketId;

    setIsUploading(true);
    setError(null);
    setUploadProgress(0);

    // An earlier lost RPC + lookup response is indeterminate. Reconcile before
    // uploading any bytes again: a committed ticket must keep its canonical
    // objects unchanged, while a proven absence may safely retry the frozen
    // intent with the same UUID and idempotency key.
    if (commitMayHaveOccurredRef.current) {
      const priorLookup = await supabase
        .from('blend_tickets')
        .select('id, ticket_number')
        .eq('id', ticketId)
        .maybeSingle();
      if (priorLookup.error) {
        setAttemptUncertain(true);
        setError('Upload status is still uncertain. No files were changed; retry to check again.');
        setIsUploading(false);
        return;
      }
      if (priorLookup.data) {
        setUploadProgress(100);
        finishCommittedUpload(ticketId);
        setIsUploading(false);
        return;
      }
      commitMayHaveOccurredRef.current = false;
      setAttemptUncertain(false);
    }

    // The object prefix is derived only from the stable ticket UUID so a retry
    // across midnight/month-end cannot upload into a second orphan folder.
    const folderPath = ticketId;
    const uploadedPaths: string[] = restoredAttempt
      ? restoredAttempt.images.map((image) => image.storage_path)
      : [];
    // Any failure before the atomic RPC starts is definitely uncommitted and
    // must remove objects already uploaded by an earlier loop iteration. Once
    // the RPC starts, a transport failure is indeterminate until lookup proves
    // whether the ticket committed.
    let definiteRollback = !commitMayHaveOccurredRef.current;

    const cleanupUploadedObjects = async (): Promise<boolean> => {
      if (uploadedPaths.length === 0) return true;
      const { error: cleanupError } = await supabase.storage
        .from('blend-ticket-images')
        .remove(uploadedPaths);
      if (cleanupError) {
        Sentry.captureException(new Error(cleanupError.message), {
          level: 'warning',
          extra: { context: 'Failed to clean up uncommitted blend-ticket uploads', ticketId },
        });
        return false;
      }
      return true;
    };

    try {
      const imageMetadata: Array<{
        storage_path: string;
        file_size: number;
        mime_type: string;
        upload_order: number;
      }> = restoredAttempt ? [...restoredAttempt.images] : [];

      for (let i = restoredAttempt ? images.length : 0; i < images.length; i++) {
        const compressedFile = await compressImage(images[i].file);
        if (!ALLOWED_TYPES.includes(compressedFile.type)) {
          throw new Error('Compressed image type must be JPEG, PNG, or WebP');
        }
        if (compressedFile.size < 1 || compressedFile.size > 10 * 1024 * 1024) {
          throw new Error('Compressed image must be between 1 byte and 10MB');
        }

        const fileExt = compressedFile.type === 'image/png'
          ? 'png'
          : compressedFile.type === 'image/webp'
            ? 'webp'
            : 'jpg';
        const filePath = `${folderPath}/${i + 1}.${fileExt}`;
        // Include the attempted path before awaiting Storage: a lost upload
        // response can still mean the object was written and needs cleanup.
        uploadedPaths.push(filePath);

        const { error: uploadError } = await supabase.storage
          .from('blend-ticket-images')
          .upload(filePath, compressedFile, {
            contentType: compressedFile.type,
            upsert: true,
          });

        if (uploadError) throw uploadError;

        imageMetadata.push({
          storage_path: filePath,
          file_size: compressedFile.size,
          mime_type: compressedFile.type,
          upload_order: i + 1,
        });
        setUploadProgress(Math.round(((i + 1) / images.length) * 90));
      }

      const ticketPayload = restoredAttempt?.ticketPayload ?? {
        customer_id: selectedCustomerId || null,
        ticket_date: ticketDate || null,
        driver_name: driverName || null,
        tank_number: tankNumber || null,
      };
      const idempotencyKey = restoredAttempt?.idempotencyKey ?? getUploadKey();
      const frozenAttempt: PersistedUncertainUpload = restoredAttempt ?? {
        version: 1,
        userId: profile.id,
        ticketId,
        idempotencyKey,
        expiresAt: Date.now() + UNCERTAIN_UPLOAD_TTL_MS,
        ticketPayload,
        images: imageMetadata,
      };
      persistUncertainAttempt(frozenAttempt);

      definiteRollback = false;
      commitMayHaveOccurredRef.current = true;
      const { data, error: createError } = await supabase.rpc('create_blend_ticket', {
        p_ticket_id: ticketId,
        p_ticket_payload: ticketPayload,
        p_products: [],
        p_images: imageMetadata,
        p_enqueue_ocr: true,
        p_performed_by: profile.id,
        p_idempotency_key: idempotencyKey,
      });

      if (createError) {
        // Distinguish a definite transaction failure from an indeterminate lost
        // response. If the ticket exists, the atomic RPC committed and its
        // uploaded objects must be retained.
        const lookup = await supabase
          .from('blend_tickets')
          .select('id, ticket_number')
          .eq('id', ticketId)
          .maybeSingle();

        if (lookup.error) {
          setAttemptUncertain(true);
          throw createError;
        }
        if (!lookup.data) {
          definiteRollback = true;
          commitMayHaveOccurredRef.current = false;
          throw createError;
        }
      } else {
        const result = assertRpcResult<{
          success: boolean;
          ticket_id: string;
          ticket_number: string;
        }>(data, 'create_blend_ticket');
        if (!result.success || result.ticket_id !== ticketId) {
          definiteRollback = true;
          commitMayHaveOccurredRef.current = false;
          throw new Error('Blend ticket retry identity mismatch; uploaded files were not attached');
        }
      }

      setUploadProgress(100);
      finishCommittedUpload(ticketId);
    } catch (err: unknown) {
      const commitStatusUncertain = !definiteRollback && commitMayHaveOccurredRef.current;
      if (commitStatusUncertain) {
        // A rejected RPC promise is just as indeterminate as a resolved
        // transport error: PostgreSQL may have committed before the response
        // was lost. Keep the frozen UUID/key/objects and force reconciliation
        // before allowing the user to change or retry the upload intent.
        setAttemptUncertain(true);
      }
      if (definiteRollback) {
        const cleaned = await cleanupUploadedObjects();
        if (cleaned) {
          resetUploadKey();
          clearPersistedAttempt();
          ticketAttemptIdRef.current = null;
          commitMayHaveOccurredRef.current = false;
          setAttemptUncertain(false);
        }
      }
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { extra: { context: 'Upload error', ticketId, definiteRollback } },
      );
      setError(commitStatusUncertain
        ? 'Upload status is uncertain. No files were changed; retry to check again.'
        : err instanceof Error ? err.message : 'Failed to upload images');
    } finally {
      setIsUploading(false);
    }
  };
  const totalSize = images.reduce((sum, img) => sum + img.file.size, 0);
  const totalSizeMB = (totalSize / (1024 * 1024)).toFixed(2);
  const intentLocked = isUploading || attemptUncertain;

  return (
    <Card className="p-6">
      <h2 className="text-xl font-semibold mb-4">Upload Blend Ticket</h2>

      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Customer (Optional)
            </label>
            <select
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
              disabled={intentLocked}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">Select Customer</option>
              {customers.map(customer => (
                <option key={customer.id} value={customer.id}>
                  {customer.farm_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Ticket Date (Optional)
            </label>
            <Input
              type="date"
              value={ticketDate}
              onChange={(e) => setTicketDate(e.target.value)}
              disabled={intentLocked}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Driver Name (Optional)
            </label>
            <Input
              type="text"
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
              placeholder="Enter driver name"
              disabled={intentLocked}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Tank Number (Optional)
            </label>
            <Input
              type="text"
              value={tankNumber}
              onChange={(e) => setTankNumber(e.target.value)}
              placeholder="Enter tank number"
              disabled={intentLocked}
            />
          </div>
        </div>

        <div
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            isDragging
              ? 'border-blue-500 bg-blue-50'
              : 'border-gray-300 hover:border-gray-400'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileSelect}
            className="hidden"
            disabled={intentLocked}
          />

          <Upload className="mx-auto h-12 w-12 text-gray-400 mb-4" />
          <p className="text-lg font-medium text-gray-900 mb-2">
            Drop images here or click to upload
          </p>
          <p className="text-sm text-gray-500 mb-4">
            JPEG, PNG, WebP up to 10MB each (max {MAX_IMAGES} images)
          </p>
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={intentLocked}
          >
            Select Images
          </Button>
        </div>

        {images.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-gray-700">
                {images.length} image{images.length !== 1 ? 's' : ''} selected ({totalSizeMB} MB)
              </p>
              {!intentLocked && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    images.forEach(img => URL.revokeObjectURL(img.preview));
                    setImages([]);
                  }}
                >
                  Clear All
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {images.map((image) => (
                <div key={image.id} className="relative group">
                  <div className="aspect-square rounded-lg overflow-hidden bg-gray-100 border border-gray-200">
                    <img
                      src={image.preview}
                      alt="Preview"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  {!intentLocked && (
                    <button
                      onClick={() => removeImage(image.id)}
                      className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                  <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-xs px-2 py-1 rounded">
                    {(image.file.size / 1024).toFixed(0)} KB
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {isUploading && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">Uploading images...</span>
              <span className="font-medium">{uploadProgress}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button
            variant="secondary"
            onClick={() => {
              images.forEach(img => URL.revokeObjectURL(img.preview));
              setImages([]);
              clearPersistedAttempt();
              ticketAttemptIdRef.current = null;
              commitMayHaveOccurredRef.current = false;
              setError(null);
            }}
            disabled={intentLocked || images.length === 0}
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={isUploading || (images.length === 0 && !attemptUncertain)}
          >
            {isUploading
              ? 'Uploading...'
              : attemptUncertain
                ? 'Check Upload Status & Retry'
                : `Upload ${images.length} Image${images.length !== 1 ? 's' : ''}`}
          </Button>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex gap-2">
            <ImageIcon className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-1">Images will be processed in the background</p>
              <p>After upload, OCR will automatically extract product information. You'll receive a notification when processing is complete.</p>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
