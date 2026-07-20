import { dataService } from 'librechat-data-provider';

/* VIVENTIUM START — permissive, platform-first HEIC conversion without bundled LGPL codecs. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx']);
const INPUT_LIMIT_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 40_000_000;

export type HeicConversionErrorCode = 'unsupported' | 'invalid' | 'busy' | 'failed';

export class HeicConversionError extends Error {
  constructor(public readonly code: HeicConversionErrorCode) {
    super(`HEIC conversion ${code}`);
    this.name = 'HeicConversionError';
  }
}

function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new HeicConversionError('invalid'));
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(reader.result)
        : reject(new HeicConversionError('invalid'));
    reader.readAsArrayBuffer(blob);
  });
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Response could not be read'));
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Response could not be read'));
    reader.readAsText(blob);
  });
}

function fourCharacterCode(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

async function hasHeicSignature(file: File): Promise<boolean> {
  if (file.size < 16) {
    return false;
  }
  const firstBytes = await readBlobArrayBuffer(file.slice(0, 8));
  const header = new DataView(firstBytes);
  const headerBytes = new Uint8Array(firstBytes);
  const boxSize = header.getUint32(0);
  if (
    boxSize < 16 ||
    boxSize > file.size ||
    boxSize > 4096 ||
    fourCharacterCode(headerBytes, 4) !== 'ftyp'
  ) {
    return false;
  }

  const box = await readBlobArrayBuffer(file.slice(0, boxSize));
  const bytes = new Uint8Array(box);
  for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
    if (offset !== 12 && HEIC_BRANDS.has(fourCharacterCode(bytes, offset))) {
      return true;
    }
  }
  return false;
}

export const isHEICFile = async (file: File): Promise<boolean> => {
  const declaredHeic =
    file.type.toLowerCase() === 'image/heic' ||
    file.type.toLowerCase() === 'image/heif' ||
    /\.(heic|heif)$/i.test(file.name);
  try {
    return declaredHeic || (await hasHeicSignature(file));
  } catch {
    return declaredHeic;
  }
};

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new HeicConversionError('failed'))),
      'image/jpeg',
      quality,
    );
  });
}

async function convertWithBrowser(file: File, quality: number): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') {
    throw new HeicConversionError('unsupported');
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (
      bitmap.width < 1 ||
      bitmap.height < 1 ||
      bitmap.width > MAX_DIMENSION ||
      bitmap.height > MAX_DIMENSION ||
      bitmap.width * bitmap.height > MAX_PIXELS
    ) {
      throw new HeicConversionError('invalid');
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new HeicConversionError('failed');
    }
    context.drawImage(bitmap, 0, 0);
    return await canvasToJpeg(canvas, quality);
  } finally {
    bitmap.close();
  }
}

async function responseErrorCode(error: unknown): Promise<string | undefined> {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (data instanceof Blob) {
    try {
      return (JSON.parse(await readBlobText(data)) as { code?: string }).code;
    } catch {
      return undefined;
    }
  }
  if (data && typeof data === 'object' && 'code' in data) {
    return String((data as { code: unknown }).code);
  }
  return undefined;
}

async function convertWithNativeFallback(file: File): Promise<Blob> {
  const form = new FormData();
  form.append('file', file, file.name);
  try {
    const result = await dataService.convertNativeHeic(form);
    const signature = new Uint8Array(await readBlobArrayBuffer(result.slice(0, 3)));
    if (
      result.type !== 'image/jpeg' ||
      signature.length !== 3 ||
      signature[0] !== 0xff ||
      signature[1] !== 0xd8 ||
      signature[2] !== 0xff
    ) {
      throw new HeicConversionError('failed');
    }
    return result;
  } catch (error) {
    if (error instanceof HeicConversionError) {
      throw error;
    }
    const code = await responseErrorCode(error);
    if (code === 'native_heic_busy') {
      throw new HeicConversionError('busy');
    }
    if (code === 'invalid_heic' || code === 'native_heic_invalid_input') {
      throw new HeicConversionError('invalid');
    }
    if (
      code?.startsWith('native_heic_conversion') ||
      code === 'native_heic_unsupported_dimensions'
    ) {
      throw new HeicConversionError('failed');
    }
    throw new HeicConversionError('unsupported');
  }
}

export const convertHEICToJPEG = async (
  file: File,
  quality: number = 0.9,
  onProgress?: (progress: number) => void,
): Promise<File> => {
  if (
    file.size === 0 ||
    file.size > INPUT_LIMIT_BYTES ||
    !(await hasHeicSignature(file)) ||
    !Number.isFinite(quality) ||
    quality < 0 ||
    quality > 1
  ) {
    throw new HeicConversionError('invalid');
  }

  onProgress?.(0.3);
  let convertedBlob: Blob;
  try {
    convertedBlob = await convertWithBrowser(file, quality);
  } catch {
    convertedBlob = await convertWithNativeFallback(file);
  }
  onProgress?.(0.8);

  const convertedFile = new File([convertedBlob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), {
    type: 'image/jpeg',
    lastModified: file.lastModified,
  });
  onProgress?.(1);
  return convertedFile;
};

export const processFileForUpload = async (
  file: File,
  quality: number = 0.9,
  onProgress?: (progress: number) => void,
): Promise<File> => {
  return (await isHEICFile(file)) ? convertHEICToJPEG(file, quality, onProgress) : file;
};
/* VIVENTIUM END */
