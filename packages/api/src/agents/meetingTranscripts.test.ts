/* === VIVENTIUM START ===
 * Feature: Meeting transcript runtime helper tests
 * Added: 2026-05-05
 * === VIVENTIUM END === */

import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { EToolResources, FileContext } from 'librechat-data-provider';
import type { AgentToolResources, TFile } from 'librechat-data-provider';
import {
  ensureMeetingTranscriptTool,
  getMeetingTranscriptKindFilter,
  getMeetingTranscriptRagMode,
  getMeetingTranscriptSourcePathHash,
  meetingTranscriptFileMatchesRagMode,
  meetingTranscriptRuntimeEnabled,
  mergeMeetingTranscriptResources,
} from './meetingTranscripts';

const transcriptFiles: TFile[] = [
  {
    user: 'user1',
    file_id: 'meeting_transcript:user1:abc',
    filename: 'meeting-transcript-abc.txt',
    filepath: 'vectordb',
    object: 'file',
    type: 'text/plain',
    bytes: 123,
    embedded: true,
    usage: 0,
    context: FileContext.meeting_transcript,
    metadata: {
      meetingTranscriptKind: 'summary',
    },
  },
];

describe('meeting transcript runtime helpers', () => {
  const oldEnv = process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR;
  const oldMode = process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE;
  const oldHome = process.env.HOME;
  const oldAppSupport = process.env.VIVENTIUM_APP_SUPPORT_DIR;
  const oldLibreChatDir = process.env.LIBRECHAT_DIR;

  afterEach(() => {
    if (oldEnv === undefined) {
      delete process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR;
    } else {
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR = oldEnv;
    }
    if (oldMode === undefined) {
      delete process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE;
    } else {
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE = oldMode;
    }
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    if (oldAppSupport === undefined) {
      delete process.env.VIVENTIUM_APP_SUPPORT_DIR;
    } else {
      process.env.VIVENTIUM_APP_SUPPORT_DIR = oldAppSupport;
    }
    if (oldLibreChatDir === undefined) {
      delete process.env.LIBRECHAT_DIR;
    } else {
      process.env.LIBRECHAT_DIR = oldLibreChatDir;
    }
  });

  it('enables only when the configured transcript folder exists', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-transcripts-'));
    try {
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR = tempDir;
      expect(meetingTranscriptRuntimeEnabled()).toBe(true);
      expect(getMeetingTranscriptSourcePathHash()).toMatch(/^[a-f0-9]{16}$/);
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR = path.join(tempDir, 'missing');
      expect(meetingTranscriptRuntimeEnabled()).toBe(false);
      expect(getMeetingTranscriptSourcePathHash()).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('expands tilde transcript paths before hashing runtime resources', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-home-'));
    const transcriptDir = path.join(fakeHome, 'meeting-transcripts');
    fs.mkdirSync(transcriptDir);
    try {
      process.env.HOME = fakeHome;
      process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR = '~/meeting-transcripts';

      const expectedHash = crypto
        .createHash('sha256')
        .update(path.resolve(transcriptDir))
        .digest('hex')
        .slice(0, 16);

      expect(meetingTranscriptRuntimeEnabled()).toBe(true);
      expect(getMeetingTranscriptSourcePathHash()).toBe(expectedHash);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('falls back to generated App Support env when the launch process missed transcript env', () => {
    const fakeAppSupport = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-app-support-'));
    const fakeLibreChat = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-librechat-'));
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-transcripts-runtime-'));
    const serviceEnvDir = path.join(fakeAppSupport, 'runtime', 'service-env');
    try {
      delete process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR;
      delete process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE;
      process.env.VIVENTIUM_APP_SUPPORT_DIR = fakeAppSupport;
      process.env.LIBRECHAT_DIR = fakeLibreChat;
      fs.mkdirSync(serviceEnvDir, { recursive: true });
      fs.writeFileSync(
        path.join(serviceEnvDir, 'librechat.env'),
        [
          `VIVENTIUM_MEMORY_TRANSCRIPTS_DIR='${transcriptDir}'`,
          'VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE=raw_only',
          '',
        ].join('\n'),
        'utf8',
      );

      const expectedHash = crypto
        .createHash('sha256')
        .update(path.resolve(transcriptDir))
        .digest('hex')
        .slice(0, 16);
      expect(getMeetingTranscriptSourcePathHash()).toBe(expectedHash);
      expect(getMeetingTranscriptRagMode()).toBe('raw_only');
    } finally {
      fs.rmSync(fakeAppSupport, { recursive: true, force: true });
      fs.rmSync(fakeLibreChat, { recursive: true, force: true });
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  it('uses the same runtime env precedence as the memory hardening wrapper', () => {
    const fakeAppSupport = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-app-support-'));
    const fakeLibreChat = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-librechat-'));
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-transcripts-runtime-'));
    const serviceEnvDir = path.join(fakeAppSupport, 'runtime', 'service-env');
    try {
      delete process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_DIR;
      delete process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE;
      process.env.VIVENTIUM_APP_SUPPORT_DIR = fakeAppSupport;
      process.env.LIBRECHAT_DIR = fakeLibreChat;
      fs.mkdirSync(serviceEnvDir, { recursive: true });
      fs.writeFileSync(path.join(fakeLibreChat, '.env'), 'VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE=raw_only\n', 'utf8');
      fs.writeFileSync(
        path.join(fakeAppSupport, 'runtime', 'runtime.env'),
        [
          `VIVENTIUM_MEMORY_TRANSCRIPTS_DIR='${transcriptDir}'`,
          'VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE=detailed_summary_only',
          '',
        ].join('\n'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(serviceEnvDir, 'librechat.env'),
        [
          "VIVENTIUM_MEMORY_TRANSCRIPTS_DIR=''",
          "VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE=''",
          '',
        ].join('\n'),
        'utf8',
      );

      const expectedHash = crypto
        .createHash('sha256')
        .update(path.resolve(transcriptDir))
        .digest('hex')
        .slice(0, 16);
      expect(getMeetingTranscriptSourcePathHash()).toBe(expectedHash);
      expect(getMeetingTranscriptRagMode()).toBe('detailed_summary_only');
    } finally {
      fs.rmSync(fakeAppSupport, { recursive: true, force: true });
      fs.rmSync(fakeLibreChat, { recursive: true, force: true });
      fs.rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  it('merges transcript files into file_search resources without duplicating ids', () => {
    const existingResources: AgentToolResources = {
      [EToolResources.file_search]: {
        file_ids: ['meeting_transcript:user1:abc'],
        files: [...transcriptFiles],
      },
    };

    const result = mergeMeetingTranscriptResources({
      tool_resources: existingResources,
      transcriptFiles,
    });

    expect(result?.[EToolResources.file_search]?.files).toHaveLength(1);
    expect(result?.[EToolResources.file_search]?.file_ids).toEqual([
      'meeting_transcript:user1:abc',
    ]);
  });

  it('defaults to detailed summary-only RAG attachment by transcript metadata kind', () => {
    const rawFile = {
      ...transcriptFiles[0],
      file_id: 'meeting_transcript:user1:abc',
      metadata: { meetingTranscriptKind: 'raw' },
    };
    const summaryFile = {
      ...transcriptFiles[0],
      file_id: 'meeting_summary:user1:abc',
      metadata: { meetingTranscriptKind: 'summary' },
    };

    expect(getMeetingTranscriptRagMode()).toBe('detailed_summary_only');
    expect(getMeetingTranscriptKindFilter()).toEqual(['summary', 'inventory']);
    expect(meetingTranscriptFileMatchesRagMode(rawFile)).toBe(false);
    expect(meetingTranscriptFileMatchesRagMode(summaryFile)).toBe(true);

    const result = mergeMeetingTranscriptResources({
      transcriptFiles: [rawFile, summaryFile],
    });

    expect(result?.[EToolResources.file_search]?.file_ids).toEqual(['meeting_summary:user1:abc']);
  });

  it('can explicitly attach raw and summary transcript artifacts for QA comparison', () => {
    process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE = 'raw_and_summary';
    const rawFile = {
      ...transcriptFiles[0],
      file_id: 'meeting_transcript:user1:abc',
      metadata: { meetingTranscriptKind: 'raw' },
    };
    const summaryFile = {
      ...transcriptFiles[0],
      file_id: 'meeting_summary:user1:abc',
      metadata: { meetingTranscriptKind: 'summary' },
    };

    const result = mergeMeetingTranscriptResources({
      transcriptFiles: [rawFile, summaryFile],
    });

    expect(result?.[EToolResources.file_search]?.file_ids).toEqual([
      'meeting_transcript:user1:abc',
      'meeting_summary:user1:abc',
    ]);
  });

  it('attaches the transcript inventory with summary recall but not raw-only QA mode', () => {
    const inventoryFile = {
      ...transcriptFiles[0],
      file_id: 'meeting_inventory:user1:sourcehash',
      metadata: { meetingTranscriptKind: 'inventory' },
    };

    expect(meetingTranscriptFileMatchesRagMode(inventoryFile)).toBe(true);
    expect(
      mergeMeetingTranscriptResources({
        transcriptFiles: [inventoryFile],
      })?.[EToolResources.file_search]?.file_ids,
    ).toEqual(['meeting_inventory:user1:sourcehash']);

    process.env.VIVENTIUM_MEMORY_TRANSCRIPTS_RAG_MODE = 'raw_only';
    expect(meetingTranscriptFileMatchesRagMode(inventoryFile)).toBe(false);
  });

  it('adds file_search when transcript recall resources are attached', () => {
    expect(ensureMeetingTranscriptTool(['web_search'])).toEqual(['web_search', 'file_search']);
  });
});
