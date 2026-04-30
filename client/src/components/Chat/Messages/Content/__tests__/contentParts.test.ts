import { ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { filterRenderableContentParts } from '../contentPartUtils';

describe('filterRenderableContentParts', () => {
  it('keeps undefined content empty', () => {
    expect(filterRenderableContentParts(undefined)).toBeUndefined();
    expect(filterRenderableContentParts(null)).toBeUndefined();
  });

  it('normalizes legacy string content into a text part', () => {
    expect(filterRenderableContentParts('Legacy text message')).toEqual([
      {
        type: ContentTypes.TEXT,
        text: 'Legacy text message',
      },
    ]);
  });

  it('normalizes single content part objects into an array', () => {
    const part: TMessageContentParts = {
      type: ContentTypes.TEXT,
      text: 'Single object part',
    };

    expect(filterRenderableContentParts(part)).toEqual([part]);
  });

  it('normalizes text-like malformed objects without crashing', () => {
    expect(
      filterRenderableContentParts({ text: 'Recovered text' } as unknown as TMessageContentParts),
    ).toEqual([
      {
        type: ContentTypes.TEXT,
        text: 'Recovered text',
      },
    ]);
  });

  it('drops unsupported malformed content instead of crashing', () => {
    expect(
      filterRenderableContentParts({ unexpected: true } as unknown as TMessageContentParts),
    ).toEqual([]);
    expect(
      filterRenderableContentParts([
        { type: ContentTypes.TEXT, text: 'Visible' },
        42 as unknown as TMessageContentParts,
      ]),
    ).toEqual([{ type: ContentTypes.TEXT, text: 'Visible' }, undefined]);
  });

  it('keeps only the latest streamed snapshot for each tool_call id', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_projects',
          name: 'projects_list',
          args: {},
          type: ToolCallTypes.TOOL_CALL,
        },
      },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_projects',
          name: 'projects_list',
          args: '',
          type: ToolCallTypes.TOOL_CALL,
        },
      },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_projects',
          name: 'projects_list',
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output: '[{"project_id":"prj_public_safe"}]',
        },
      },
      {
        type: ContentTypes.TEXT,
        text: 'Done.',
      },
    ];

    expect(filterRenderableContentParts(parts)).toEqual([parts[2], parts[3]]);
  });

  it('merges adjacent streamed text parts so words do not render as separate blocks', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_worker_run',
          name: 'worker_run',
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output: '{"state":"running"}',
        },
      },
      { type: ContentTypes.TEXT, text: 'Cod' },
      { type: ContentTypes.TEXT, text: 'ex is ' },
      { type: ContentTypes.TEXT, text: 'on it.' },
    ];

    expect(filterRenderableContentParts(parts)).toEqual([
      parts[0],
      {
        type: ContentTypes.TEXT,
        text: 'Codex is on it.',
      },
    ]);
  });

  it('does not merge text across non-text parts', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'Before ' },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_worker_run',
          name: 'worker_run',
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
        },
      },
      { type: ContentTypes.TEXT, text: 'After' },
    ];

    expect(filterRenderableContentParts(parts)).toEqual(parts);
  });

  it('keeps the original array reference when there are no superseded snapshots', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_projects',
          name: 'projects_list',
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output: '[{"project_id":"prj_public_safe"}]',
        },
      },
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });
});
