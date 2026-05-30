/**
 * imageCompression.test.ts — Tests for client-side image compression utility
 *
 * Mocks all DOM canvas/bitmap APIs since jsdom doesn't support them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compressImage } from './imageCompression';

// ── DOM API Mocks ────────────────────────────────────────────────────────

function makeFile(name: string, size: number, type = 'image/jpeg'): File {
  // Create a file of the specified size
  const buffer = new ArrayBuffer(size);
  return new File([buffer], name, { type });
}

let mockBlobSize = 800 * 1024; // Default: 800KB output

function setupCanvasMock() {
  const mockCtx = {
    drawImage: vi.fn(),
  };

  const mockCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn().mockReturnValue(mockCtx),
    toBlob: vi.fn().mockImplementation((cb: (blob: Blob | null) => void, _type: string, _quality: number) => {
      const blob = new Blob([new ArrayBuffer(mockBlobSize)], { type: 'image/jpeg' });
      cb(blob);
    }),
  };

  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') return mockCanvas as unknown as HTMLCanvasElement;
    return document.createElement(tag);
  });

  const mockBitmap = {
    width: 3000,
    height: 2000,
    close: vi.fn(),
  };

  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(mockBitmap));

  return { mockCtx, mockCanvas, mockBitmap };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('compressImage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockBlobSize = 800 * 1024;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns non-image files unchanged', async () => {
    const file = makeFile('data.csv', 2 * 1024 * 1024, 'text/csv');
    const result = await compressImage(file);
    expect(result).toBe(file);
  });

  it('returns small images (< 500KB) unchanged', async () => {
    const file = makeFile('small.jpg', 200 * 1024, 'image/jpeg');
    const result = await compressImage(file);
    expect(result).toBe(file);
  });

  it('compresses a large image and returns a smaller File', async () => {
    setupCanvasMock();
    const file = makeFile('photo.png', 5 * 1024 * 1024, 'image/png');
    mockBlobSize = 700 * 1024; // Compressed output is 700KB

    const result = await compressImage(file);

    expect(result).not.toBe(file);
    expect(result.name).toBe('photo.jpg'); // Converted to JPEG
    expect(result.type).toBe('image/jpeg');
    expect(result.size).toBeLessThan(file.size);
  });

  it('resizes landscape image (width > height) to max 1920px width', async () => {
    const { mockCanvas, mockBitmap } = setupCanvasMock();
    mockBitmap.width = 4000;
    mockBitmap.height = 3000;
    mockBlobSize = 500 * 1024;

    const file = makeFile('wide.jpg', 2 * 1024 * 1024, 'image/jpeg');
    await compressImage(file);

    expect(mockCanvas.width).toBe(1920);
    expect(mockCanvas.height).toBe(1440); // 3000/4000 * 1920
  });

  it('resizes portrait image (height > width) to max 1920px height', async () => {
    const { mockCanvas, mockBitmap } = setupCanvasMock();
    mockBitmap.width = 1500;
    mockBitmap.height = 4000;
    mockBlobSize = 500 * 1024;

    const file = makeFile('tall.jpg', 2 * 1024 * 1024, 'image/jpeg');
    await compressImage(file);

    expect(mockCanvas.height).toBe(1920);
    expect(mockCanvas.width).toBe(720); // 1500/4000 * 1920
  });

  it('does not resize images within dimension limits', async () => {
    const { mockCanvas, mockBitmap } = setupCanvasMock();
    mockBitmap.width = 1200;
    mockBitmap.height = 800;
    mockBlobSize = 400 * 1024;

    const file = makeFile('normal.jpg', 600 * 1024, 'image/jpeg');
    await compressImage(file);

    expect(mockCanvas.width).toBe(1200);
    expect(mockCanvas.height).toBe(800);
  });

  it('reduces quality when output exceeds 1MB', async () => {
    const { mockCanvas } = setupCanvasMock();
    let callCount = 0;
    mockCanvas.toBlob.mockImplementation((cb: (blob: Blob | null) => void) => {
      callCount++;
      // First 3 calls: too big; 4th call: under 1MB
      const size = callCount < 4 ? 1.5 * 1024 * 1024 : 500 * 1024;
      cb(new Blob([new ArrayBuffer(size)], { type: 'image/jpeg' }));
    });

    const file = makeFile('huge.jpg', 8 * 1024 * 1024, 'image/jpeg');
    const result = await compressImage(file);

    expect(result).not.toBe(file);
    // toBlob called multiple times (initial + quality reductions)
    expect(mockCanvas.toBlob).toHaveBeenCalledTimes(callCount);
    expect(callCount).toBeGreaterThan(1);
  });

  it('returns original file if compressed is larger', async () => {
    setupCanvasMock();
    const file = makeFile('already-small.jpg', 600 * 1024, 'image/jpeg');
    mockBlobSize = 800 * 1024; // Compressed is bigger than original

    const result = await compressImage(file);
    expect(result).toBe(file);
  });

  it('returns original file if canvas context is null', async () => {
    const mocks = setupCanvasMock();
    mocks.mockCanvas.getContext.mockReturnValue(null);
    const file = makeFile('nocontext.jpg', 2 * 1024 * 1024, 'image/jpeg');

    const result = await compressImage(file);
    expect(result).toBe(file);
    expect(mocks.mockBitmap.close).toHaveBeenCalled();
  });

  it('returns original file on createImageBitmap error', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('Bad image')));

    const file = makeFile('corrupt.jpg', 2 * 1024 * 1024, 'image/jpeg');
    const result = await compressImage(file);

    expect(result).toBe(file);
  });

  it('closes bitmap after successful compression', async () => {
    const { mockBitmap } = setupCanvasMock();
    mockBlobSize = 500 * 1024;
    const file = makeFile('photo.jpg', 2 * 1024 * 1024, 'image/jpeg');

    await compressImage(file);
    expect(mockBitmap.close).toHaveBeenCalled();
  });

  it('renames output file with .jpg extension', async () => {
    setupCanvasMock();
    mockBlobSize = 500 * 1024;
    const file = makeFile('document.png', 2 * 1024 * 1024, 'image/png');

    const result = await compressImage(file);
    expect(result.name).toBe('document.jpg');
  });
});
