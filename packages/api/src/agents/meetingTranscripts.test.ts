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
    expect(getMeetingTranscriptKindFilter()).toEqual(['summary']);
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

  it('adds file_search when transcript recall resources are attached', () => {
    expect(ensureMeetingTranscriptTool(['web_search'])).toEqual(['web_search', 'file_search']);
  });
});
