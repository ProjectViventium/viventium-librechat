/* === VIVENTIUM START ===
 * Feature: Meeting transcript runtime resource helpers
 *
 * Purpose:
 * - Attach processed meeting transcript RAG files through the existing file_search path.
 * - Keep transcript recall opt-in gated by VIVENTIUM_MEMORY_TRANSCRIPTS_DIR.
 *
 * Added: 2026-05-05
 * === VIVENTIUM END === */

import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { EToolResources, FileContext, Tools } from 'librechat-data-provider';
import type { AgentToolResources, TFile } from 'librechat-data-provider';

type MeetingTranscriptRagMode = 'detailed_summary_only' | 'raw_and_summary' | 'raw_only';
const MEETING_TRANSCRIPT_INVENTORY_KIND = 'inventory';

function expandHomePath(value: string): string {
  const raw = String(value || '').trim();
  if (raw === '~') {
    return process.env.HOME || os.homedir();
  }
  if (raw.startsWith('~/')) {
    return path.join(process.env.HOME || os.homedir(), raw.slice(2));
  }
  return raw;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readRuntimeEnvValue(key: string): string {
  const home = process.env.HOME || os.homedir();
  const appSupportDir =
    process.env.VIVENTIUM_APP_SUPPORT_DIR ||
    path.join(home, 'Library', 'Application Support', 'Viventium');
  const runtimeDir = path.join(appSupportDir, 'runtime');
  const librechatDir = process.env.LIBRECHAT_DIR || process.cwd();
  const candidates = [
    path.join(librechatDir, '.env'),
    path.join(runtimeDir, 'local.env'),
    path.join(runtimeDir, 'librechat.env'),
    path.join(runtimeDir, 'runtime.env'),
    path.join(runtimeDir, 'runtime.local.env'),
    path.join(runtimeDir, 'service-env', 'librechat.env'),
  ];
  let resolved = '';
  for (const candidate of candidates) {
    let text = '';
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const equalsAt = trimmed.indexOf('=');
      if (equalsAt <= 0) {
        continue;
      }
      if (trimmed.slice(0, equalsAt) === key) {
        const value = unquoteEnvValue(trimmed.slice(equalsAt + 1));
        if (value === '' && resolved) {
          continue;
        }
        resolved = value;
      }
    }
  }
  return resolved;
}

function getRuntimeValue(key: string): string {
  return String(process.env[key] || readRuntimeEnvValue(key) || '');
}

export function getMeetingTranscriptSourcePathHash(): string | null {
  const sourceDir = expandHomePath(getRuntimeValue('VIVENTIUM_MEMORY_TRANSCRIPTS_DIR'));
  if (!sourceDir) {
    return null;
  }
  try {
    const resolvedDir = path.resolve(sourceDir);
    if (!fs.statSync(resolvedDir).isDirectory()) {
      return null;
    }
    return crypto.createHash('sha256').update(resolvedDir).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

export function meetingTranscriptRuntimeEnabled(): boolean {
  return Boolean(getMeetingTranscriptSourcePathHash());
}

export function getMeetingTranscriptRagMode(): MeetingTranscriptRagMode {
  const value = getRuntimeValue('VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE').trim().toLowerCase();
  if (value === 'raw_and_summary' || value === 'raw+summary' || value === 'all') {
    return 'raw_and_summary';
  }
  if (value === 'raw_only' || value === 'raw') {
    return 'raw_only';
  }
  return 'detailed_summary_only';
}

export function getMeetingTranscriptKindFilter(): string[] {
  const mode = getMeetingTranscriptRagMode();
  if (mode === 'raw_and_summary') {
    return ['summary', 'raw', MEETING_TRANSCRIPT_INVENTORY_KIND];
  }
  if (mode === 'raw_only') {
    return ['raw'];
  }
  return ['summary', MEETING_TRANSCRIPT_INVENTORY_KIND];
}

export function meetingTranscriptFileMatchesRagMode(file: TFile): boolean {
  const kind = String(file?.metadata?.meetingTranscriptKind || '').trim();
  const allowedKinds = new Set(getMeetingTranscriptKindFilter());
  return Boolean(kind && allowedKinds.has(kind));
}

export function isMeetingTranscriptInventoryResource(file: TFile): boolean {
  return (
    String(file?.metadata?.meetingTranscriptKind || '').trim() === MEETING_TRANSCRIPT_INVENTORY_KIND
  );
}

export function mergeMeetingTranscriptResources(params: {
  tool_resources?: AgentToolResources;
  transcriptFiles: TFile[];
}): AgentToolResources | undefined {
  const { tool_resources } = params;
  const transcriptFiles = params.transcriptFiles.filter(meetingTranscriptFileMatchesRagMode);
  if (!transcriptFiles.length) {
    return tool_resources;
  }

  const nextResources: AgentToolResources = { ...(tool_resources ?? {}) };
  const fileSearchResource = nextResources[EToolResources.file_search] ?? {};
  const existingFiles = fileSearchResource.files ?? [];
  const existingIds = new Set(existingFiles.map((file) => file.file_id));
  const nextFiles = [...existingFiles];

  for (const file of transcriptFiles) {
    if (!file?.file_id || existingIds.has(file.file_id)) {
      continue;
    }
    existingIds.add(file.file_id);
    nextFiles.push({
      ...file,
      context: FileContext.meeting_transcript,
      viventiumMeetingTranscriptRecall: true,
    } as TFile);
  }

  const mergedIds = new Set(fileSearchResource.file_ids ?? []);
  for (const file of nextFiles) {
    if (file.file_id) {
      mergedIds.add(file.file_id);
    }
  }

  nextResources[EToolResources.file_search] = {
    ...fileSearchResource,
    files: nextFiles,
    file_ids: Array.from(mergedIds),
  };

  return nextResources;
}

export function ensureMeetingTranscriptTool(tools?: string[] | null): string[] {
  const nextTools = Array.isArray(tools) ? [...tools] : [];
  if (!nextTools.includes(Tools.file_search)) {
    nextTools.push(Tools.file_search);
  }
  return nextTools;
}
