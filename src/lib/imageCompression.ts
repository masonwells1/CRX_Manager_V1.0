/**
 * Image compression utility for blend ticket uploads.
 * Compresses images client-side before uploading to Supabase storage.
 * Target: max 1920px on longest side, JPEG quality 0.8, max ~1MB output.
 */
import { Sentry } from './sentry';

const MAX_DIMENSION = 1920;
const JPEG_QUALITY = 0.8;
const MAX_OUTPUT_SIZE = 1 * 1024 * 1024; // 1MB

/**
 * Compress an image file using canvas.
 * - Resizes if larger than MAX_DIMENSION
 * - Converts to JPEG at JPEG_QUALITY
 * - If still too large, reduces quality further
 * Returns a new File object with the compressed image.
 */
export async function compressImage(file: File): Promise<File> {
  // Skip non-image files
  if (!file.type.startsWith('image/')) {
    return file;
  }

  // Skip small files (under 500KB) — no need to compress
  if (file.size < 500 * 1024) {
    return file;
  }

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;

    // Calculate new dimensions (keep aspect ratio)
    let newWidth = width;
    let newHeight = height;

    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      if (width > height) {
        newWidth = MAX_DIMENSION;
        newHeight = Math.round((height / width) * MAX_DIMENSION);
      } else {
        newHeight = MAX_DIMENSION;
        newWidth = Math.round((width / height) * MAX_DIMENSION);
      }
    }

    // Draw to canvas
    const canvas = document.createElement('canvas');
    canvas.width = newWidth;
    canvas.height = newHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return file;
    }

    ctx.drawImage(bitmap, 0, 0, newWidth, newHeight);
    bitmap.close();

    // Convert to JPEG blob with initial quality
    let blob = await canvasToBlob(canvas, JPEG_QUALITY);

    // If still too large, reduce quality in steps
    let quality = JPEG_QUALITY;
    while (blob.size > MAX_OUTPUT_SIZE && quality > 0.3) {
      quality -= 0.1;
      blob = await canvasToBlob(canvas, quality);
    }

    // Create new File with original name but .jpg extension
    const originalName = file.name.replace(/\.[^.]+$/, '');
    const compressedFile = new File([blob], `${originalName}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });

    // Only use compressed version if it's actually smaller
    if (compressedFile.size >= file.size) {
      return file;
    }

    return compressedFile;
  } catch (error) {
    Sentry.captureException(error, { tags: { source: 'image_compression', action: 'compress_image' } });
    return file;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Canvas toBlob failed'));
        }
      },
      'image/jpeg',
      quality
    );
  });
}
