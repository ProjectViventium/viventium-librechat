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

export function getMeetingTranscriptSourcePathHash(): string | null {
  const sourceDir = expandHomePath(process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR || '');
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
  const value = String(process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE || '')
    .trim()
    .toLowerCase();
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
    return ['summary', 'raw'];
  }
  if (mode === 'raw_only') {
    return ['raw'];
  }
  return ['summary'];
}

export function meetingTranscriptFileMatchesRagMode(file: TFile): boolean {
  const kind = String(file?.metadata?.meetingTranscriptKind || '').trim();
  const allowedKinds = new Set(getMeetingTranscriptKindFilter());
  return Boolean(kind && allowedKinds.has(kind));
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
