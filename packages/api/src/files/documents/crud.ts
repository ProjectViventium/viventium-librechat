import * as fs from 'fs';
import path from 'path';
import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { excelMimeTypes, FileSources } from 'librechat-data-provider';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { MistralOCRUploadResult } from '~/types';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const NOTES_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const PPTX_MAX_EXTRACTED_IMAGES = 20;
const PPTX_MAX_EXTRACTED_IMAGE_BYTES = 12 * 1024 * 1024;
const PPTX_MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024;
const PPTX_MAX_XML_TOTAL_BYTES = 32 * 1024 * 1024;
const PPTX_MAX_ARCHIVE_ENTRIES = 5000;
const PPTX_MAX_SLIDES = 500;
const PPTX_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Parses an uploaded document and extracts its text content and metadata.
 * Handled types must stay in sync with `documentParserMimeTypes` from data-provider.
 *
 * @throws {Error} if `file.mimetype` is not handled or no text is found.
 */
export async function parseDocument({
  file,
}: {
  file: Express.Multer.File;
}): Promise<MistralOCRUploadResult> {
  let text: string;
  let images: string[] = [];
  if (file.mimetype === 'application/pdf') {
    text = await pdfToText(file);
  } else if (
    file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    text = await wordDocToText(file);
  } else if (
    excelMimeTypes.test(file.mimetype) ||
    file.mimetype === 'application/vnd.oasis.opendocument.spreadsheet'
  ) {
    text = await excelSheetToText(file);
  } else if (file.mimetype === PPTX_MIME) {
    const presentation = await presentationDocToText(file);
    text = presentation.text;
    images = presentation.images;
  } else {
    throw new Error(`Unsupported file type in document parser: ${file.mimetype}`);
  }

  if (!text?.trim()) {
    throw new Error('No text found in document');
  }

  return {
    filename: file.originalname,
    bytes: Buffer.byteLength(text, 'utf8'),
    filepath: FileSources.document_parser,
    text,
    images,
  };
}

/** Parses PDF, returns text inside. */
async function pdfToText(file: Express.Multer.File): Promise<string> {
  // Imported inline so that Jest can test other routes without failing due to loading ESM
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const data = new Uint8Array(await fs.promises.readFile(file.path));
  const pdf = await getDocument({ data }).promise;

  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .filter((item): item is TextItem => !('type' in item))
      .map((item) => item.str)
      .join(' ');
    fullText += pageText + '\n';
  }

  return fullText;
}

/** Parses Word document, returns text inside. */
async function wordDocToText(file: Express.Multer.File): Promise<string> {
  const { extractRawText } = await import('mammoth');
  const rawText = await extractRawText({ buffer: await fs.promises.readFile(file.path) });
  return rawText.value;
}

/* === VIVENTIUM START ===
 * Feature: Shared PowerPoint message attachment extraction
 * Purpose: Let Telegram/web agent message attachments use the same document_parser path for
 * text-bearing PPTX decks instead of failing before the model can read the file.
 * === VIVENTIUM END === */
function getXmlTextContent(xml: string): string {
  const doc = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: () => undefined,
      fatalError: () => undefined,
    },
  }).parseFromString(xml, 'application/xml');
  const nodes = doc.getElementsByTagName('a:t');
  const values: string[] = [];

  for (let index = 0; index < nodes.length; index += 1) {
    const text = nodes.item(index)?.textContent?.trim();
    if (text) {
      values.push(text);
    }
  }

  return values.join('\n');
}

function getRelationshipTargets(xml: string, relationshipType: string): string[] {
  const doc = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: () => undefined,
      fatalError: () => undefined,
    },
  }).parseFromString(xml, 'application/xml');
  const relationships = doc.getElementsByTagName('Relationship');
  const targets: string[] = [];

  for (let index = 0; index < relationships.length; index += 1) {
    const node = relationships.item(index);
    const type = node?.getAttribute('Type') || '';
    const target = node?.getAttribute('Target') || '';
    if (type === relationshipType && target) {
      targets.push(target);
    }
  }

  return targets;
}

function slideRelsPath(slidePath: string): string {
  const slideDir = path.posix.dirname(slidePath);
  const slideName = path.posix.basename(slidePath);
  return path.posix.join(slideDir, '_rels', `${slideName}.rels`);
}

function resolveRelationshipTarget(sourcePath: string, target: string): string {
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), target));
  return normalized.replace(/^\/+/, '');
}

type ZipBudget = { xmlBytes: number };

function zipEntryUncompressedSize(entry: JSZip.JSZipObject): number | undefined {
  const internal = entry as unknown as { _data?: { uncompressedSize?: unknown } };
  const value = internal._data?.uncompressedSize;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function assertWithinPptxExtractionLimit(bytes: number, limit: number): void {
  if (bytes > limit) {
    throw new Error('PowerPoint content exceeds the safe extraction limit');
  }
}

async function readZipText(zip: JSZip, filePath: string, budget: ZipBudget): Promise<string> {
  const entry = zip.file(filePath);
  if (!entry) {
    return '';
  }
  const advertisedBytes = zipEntryUncompressedSize(entry);
  if (advertisedBytes != null) {
    assertWithinPptxExtractionLimit(advertisedBytes, PPTX_MAX_XML_ENTRY_BYTES);
    assertWithinPptxExtractionLimit(budget.xmlBytes + advertisedBytes, PPTX_MAX_XML_TOTAL_BYTES);
  }
  const text = await entry.async('string');
  const actualBytes = Buffer.byteLength(text, 'utf8');
  assertWithinPptxExtractionLimit(actualBytes, PPTX_MAX_XML_ENTRY_BYTES);
  if (advertisedBytes == null) {
    assertWithinPptxExtractionLimit(budget.xmlBytes + actualBytes, PPTX_MAX_XML_TOTAL_BYTES);
  }
  budget.xmlBytes += advertisedBytes ?? actualBytes;
  return text;
}

async function slideNotesText(zip: JSZip, slidePath: string, budget: ZipBudget): Promise<string> {
  const relsXml = await readZipText(zip, slideRelsPath(slidePath), budget);
  if (!relsXml) {
    return '';
  }

  const noteTargets = getRelationshipTargets(relsXml, NOTES_RELATIONSHIP_TYPE);
  const noteTexts: string[] = [];
  for (const target of noteTargets) {
    const notesPath = resolveRelationshipTarget(slidePath, target);
    const notesXml = await readZipText(zip, notesPath, budget);
    const text = notesXml ? getXmlTextContent(notesXml) : '';
    if (text) {
      noteTexts.push(text);
    }
  }

  return noteTexts.join('\n');
}

function getPresentationImageMimeType(filePath: string): string | undefined {
  return PPTX_IMAGE_MIME_BY_EXTENSION[path.posix.extname(filePath).toLowerCase()];
}

async function extractPresentationImages(zip: JSZip): Promise<string[]> {
  const images: string[] = [];
  let totalBytes = 0;
  const imageEntries = Object.keys(zip.files)
    .filter(
      (filePath) => filePath.startsWith('ppt/media/') && getPresentationImageMimeType(filePath),
    )
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  for (const filePath of imageEntries) {
    if (images.length >= PPTX_MAX_EXTRACTED_IMAGES) {
      break;
    }
    const entry = zip.file(filePath);
    const mimeType = getPresentationImageMimeType(filePath);
    if (!entry || !mimeType) {
      continue;
    }

    const advertisedBytes = zipEntryUncompressedSize(entry);
    if (
      advertisedBytes != null &&
      (advertisedBytes > PPTX_MAX_EXTRACTED_IMAGE_BYTES ||
        totalBytes + advertisedBytes > PPTX_MAX_EXTRACTED_IMAGE_BYTES)
    ) {
      continue;
    }
    const data = await entry.async('nodebuffer');
    if (!data?.length || totalBytes + data.length > PPTX_MAX_EXTRACTED_IMAGE_BYTES) {
      continue;
    }

    totalBytes += data.length;
    images.push(`data:${mimeType};base64,${data.toString('base64')}`);
  }

  return images;
}

async function presentationDocToText(
  file: Express.Multer.File,
): Promise<{ text: string; images: string[] }> {
  const data = await fs.promises.readFile(file.path);
  const zip = await JSZip.loadAsync(data);
  const archiveEntries = Object.keys(zip.files);
  assertWithinPptxExtractionLimit(archiveEntries.length, PPTX_MAX_ARCHIVE_ENTRIES);
  const slideEntries = archiveEntries
    .map((filePath) => {
      const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(filePath);
      return match ? { filePath, slideNumber: Number(match[1]) } : null;
    })
    .filter((entry): entry is { filePath: string; slideNumber: number } => entry != null)
    .sort((left, right) => left.slideNumber - right.slideNumber);
  assertWithinPptxExtractionLimit(slideEntries.length, PPTX_MAX_SLIDES);

  const slideSections: string[] = [];
  const budget: ZipBudget = { xmlBytes: 0 };
  for (const slide of slideEntries) {
    const slideXml = await readZipText(zip, slide.filePath, budget);
    const slideText = slideXml ? getXmlTextContent(slideXml) : '';
    const notesText = await slideNotesText(zip, slide.filePath, budget);
    const lines = [`Slide ${slide.slideNumber}:`];

    if (slideText) {
      lines.push(slideText);
    }
    if (notesText) {
      lines.push('Speaker Notes:', notesText);
    }
    if (lines.length > 1) {
      slideSections.push(lines.join('\n'));
    }
  }

  const images = await extractPresentationImages(zip);
  if (images.length > 0) {
    slideSections.push(
      `Embedded Media:\n${images.length} image file(s) extracted from the presentation and available as visual inputs on vision-capable message surfaces.`,
    );
  }

  return {
    text: slideSections.length ? `${slideSections.join('\n\n')}\n` : '',
    images,
  };
}
/* === VIVENTIUM END === */

/** Parses Excel sheet, returns text inside. */
async function excelSheetToText(file: Express.Multer.File): Promise<string> {
  // xlsx CDN build (0.20.x) does not bind fs internally when dynamically imported;
  // readFile() fails with "Cannot access file". read() takes a pre-loaded Buffer instead.
  const { read, utils } = await import('xlsx');
  const data = await fs.promises.readFile(file.path);
  const workbook = read(data, { type: 'buffer' });

  let text = '';
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const worksheetAsCsvString = utils.sheet_to_csv(worksheet);
    text += `${sheetName}:\n${worksheetAsCsvString}\n`;
  }

  return text;
}
