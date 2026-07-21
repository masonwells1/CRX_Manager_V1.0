const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES = 46;
const ZIP_LOCAL_FILE_HEADER_BYTES = 30;
const ZIP_MAX_COMMENT_BYTES = 65_535;

export interface XlsxArchiveSafetyLimits {
  label: string;
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries?: number;
}

export class XlsxArchiveSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxArchiveSafetyError';
  }
}

interface XlsxZipEntry {
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(view: DataView): number {
  const firstPossibleOffset = Math.max(
    0,
    view.byteLength - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES - ZIP_MAX_COMMENT_BYTES,
  );
  for (
    let offset = view.byteLength - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES;
    offset >= firstPossibleOffset;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE
      && offset + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + view.getUint16(offset + 20, true)
        === view.byteLength) {
      return offset;
    }
  }
  return -1;
}

async function measureExpandedEntry(
  arrayBuffer: ArrayBuffer,
  view: DataView,
  entry: XlsxZipEntry,
  directoryOffset: number,
  expandedBytesBeforeEntry: number,
  limits: XlsxArchiveSafetyLimits,
): Promise<number> {
  if (entry.localHeaderOffset + ZIP_LOCAL_FILE_HEADER_BYTES > directoryOffset
    || view.getUint32(entry.localHeaderOffset, true) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw new XlsxArchiveSafetyError(`${limits.label} has an invalid local file entry.`);
  }

  const localFlags = view.getUint16(entry.localHeaderOffset + 6, true);
  const localCompressionMethod = view.getUint16(entry.localHeaderOffset + 8, true);
  const localFileNameLength = view.getUint16(entry.localHeaderOffset + 26, true);
  const localExtraLength = view.getUint16(entry.localHeaderOffset + 28, true);
  if (localFlags !== entry.flags || localCompressionMethod !== entry.compressionMethod) {
    throw new XlsxArchiveSafetyError(`${limits.label} has inconsistent file metadata.`);
  }

  const dataOffset = entry.localHeaderOffset
    + ZIP_LOCAL_FILE_HEADER_BYTES
    + localFileNameLength
    + localExtraLength;
  if (dataOffset > directoryOffset || dataOffset + entry.compressedSize > directoryOffset) {
    throw new XlsxArchiveSafetyError(`${limits.label} has an invalid compressed file range.`);
  }

  if (entry.compressionMethod === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new XlsxArchiveSafetyError(`${limits.label} has an invalid stored file size.`);
    }
    if (expandedBytesBeforeEntry + entry.compressedSize > limits.maxUncompressedBytes) {
      throw new XlsxArchiveSafetyError(
        `${limits.label} may expand to at most ${limits.maxUncompressedBytes / 1024 / 1024} MB.`,
      );
    }
    return entry.compressedSize;
  }

  if (typeof DecompressionStream !== 'function') {
    throw new XlsxArchiveSafetyError('This browser cannot safely inspect compressed .xlsx files.');
  }
  const compressedBytes = new Uint8Array(arrayBuffer, dataOffset, entry.compressedSize);
  const reader = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(compressedBytes);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  let actualUncompressedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      actualUncompressedBytes += value.byteLength;
      if (expandedBytesBeforeEntry + actualUncompressedBytes > limits.maxUncompressedBytes) {
        await reader.cancel();
        throw new XlsxArchiveSafetyError(
          `${limits.label} may expand to at most ${limits.maxUncompressedBytes / 1024 / 1024} MB.`,
        );
      }
    }
  } catch (error) {
    if (error instanceof XlsxArchiveSafetyError) throw error;
    throw new XlsxArchiveSafetyError(`${limits.label} contains invalid compressed data.`);
  } finally {
    reader.releaseLock();
  }
  if (actualUncompressedBytes !== entry.uncompressedSize) {
    throw new XlsxArchiveSafetyError(`${limits.label} contains incorrect expanded-size metadata.`);
  }
  return actualUncompressedBytes;
}

/** Inspect the ZIP envelope and real expanded bytes before ExcelJS parses XML. */
export async function validateXlsxArchiveSafety(
  arrayBuffer: ArrayBuffer,
  limits: XlsxArchiveSafetyLimits,
): Promise<void> {
  if (arrayBuffer.byteLength > limits.maxCompressedBytes) {
    throw new XlsxArchiveSafetyError(
      `${limits.label} must be ${limits.maxCompressedBytes / 1024 / 1024} MB or smaller.`,
    );
  }
  if (arrayBuffer.byteLength < ZIP_END_OF_CENTRAL_DIRECTORY_BYTES) {
    throw new XlsxArchiveSafetyError(`${limits.label} is not a readable .xlsx archive.`);
  }

  const view = new DataView(arrayBuffer);
  const endOffset = findEndOfCentralDirectory(view);
  if (endOffset < 0) {
    throw new XlsxArchiveSafetyError(`${limits.label} has an invalid ZIP directory.`);
  }
  const diskNumber = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const maxEntries = limits.maxEntries ?? 2_000;
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new XlsxArchiveSafetyError(`${limits.label} cannot use a multi-disk ZIP archive.`);
  }
  if (entryCount < 1 || entryCount > maxEntries) {
    throw new XlsxArchiveSafetyError(`${limits.label} contains too many ZIP entries.`);
  }
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff
    || directoryOffset + directorySize !== endOffset) {
    throw new XlsxArchiveSafetyError(`${limits.label} has an invalid central directory range.`);
  }

  const entries: XlsxZipEntry[] = [];
  let offset = directoryOffset;
  let declaredUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES > endOffset
      || view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
      throw new XlsxArchiveSafetyError(`${limits.label} has an invalid central directory entry.`);
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    if ((flags & 0x0001) !== 0) {
      throw new XlsxArchiveSafetyError(`Encrypted ${limits.label.toLowerCase()} files are not supported.`);
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new XlsxArchiveSafetyError(`${limits.label} uses unsupported ZIP compression.`);
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff) {
      throw new XlsxArchiveSafetyError(`ZIP64 ${limits.label.toLowerCase()} files are not supported.`);
    }
    if (compressedSize === 0 && uncompressedSize > 0) {
      throw new XlsxArchiveSafetyError(`${limits.label} has an invalid file size.`);
    }
    declaredUncompressedBytes += uncompressedSize;
    if (declaredUncompressedBytes > limits.maxUncompressedBytes) {
      throw new XlsxArchiveSafetyError(
        `${limits.label} may expand to at most ${limits.maxUncompressedBytes / 1024 / 1024} MB.`,
      );
    }
    entries.push({
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES + fileNameLength + extraLength + commentLength;
  }
  if (offset !== endOffset) {
    throw new XlsxArchiveSafetyError(`${limits.label} central directory length is inconsistent.`);
  }

  let actualUncompressedBytes = 0;
  for (const entry of entries) {
    actualUncompressedBytes += await measureExpandedEntry(
      arrayBuffer,
      view,
      entry,
      directoryOffset,
      actualUncompressedBytes,
      limits,
    );
  }
}
