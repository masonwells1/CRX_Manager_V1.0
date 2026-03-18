import { useRef, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import { compressImage } from '../../lib/imageCompression';

interface NotePhotoUploadProps {
  noteId: string;
  onUploadComplete: () => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export default function NotePhotoUpload({ noteId, onUploadComplete }: NotePhotoUploadProps) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !profile) return;

    // Check file sizes before uploading
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_SIZE) {
        toast('error', `"${file.name}" exceeds 10MB limit`);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
    }

    setUploading(true);
    let uploadCount = 0;

    for (const rawFile of Array.from(files)) {
      try {
        const file = await compressImage(rawFile);
        const ext = file.name.split('.').pop() || 'jpg';
        const storagePath = `team-note-attachments/${profile.id}/${Date.now()}_${uploadCount}.${ext}`;

        const { error: uploadErr } = await supabase.storage
          .from('team-note-attachments')
          .upload(storagePath, file, { contentType: file.type });

        if (uploadErr) {
          toast('error', `Upload failed: ${uploadErr.message}`);
          continue;
        }

        const { data: urlData } = supabase.storage
          .from('team-note-attachments')
          .getPublicUrl(storagePath);

        const insertResult = await supabase.from('team_note_attachments').insert({
          note_id: noteId,
          file_url: urlData.publicUrl,
          file_name: rawFile.name,
          file_type: file.type,
          file_size_bytes: file.size,
          uploaded_by: profile.id,
        });

        if (insertResult.error) {
          toast('error', `Photo saved to storage but DB record failed: ${insertResult.error.message}`);
          continue;
        }

        uploadCount++;
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'Photo upload error' } });
        toast('error', 'Photo upload failed. Please try again.');
      }
    }

    if (uploadCount > 0) {
      toast('success', `${uploadCount} photo${uploadCount > 1 ? 's' : ''} uploaded`);
      onUploadComplete();
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={handleFileChange}
        disabled={uploading}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="w-full min-h-[44px] flex items-center justify-center gap-2 border-2 border-dashed border-gray-300 rounded-lg px-4 py-3 text-sm text-gray-500 hover:border-crx-green hover:text-crx-green transition-colors disabled:opacity-50"
      >
        {uploading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Uploading...</span>
          </>
        ) : (
          <>
            <Camera className="w-5 h-5" />
            <span>Add Photos</span>
          </>
        )}
      </button>
    </div>
  );
}
