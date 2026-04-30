import { Constants, ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { groupParallelContent } from '../ParallelContent';
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

  it('collapses consecutive GlassHive tool rows into the latest status row', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_projects',
          name: `projects_list${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output: '[{"project_id":"prj_public_safe"}]',
        },
      },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_create',
          name: `worker_create${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output: '{"worker_id":"wrk_public_safe"}',
        },
      },
      {
        type: ContentTypes.TEXT,
        text: 'Done.',
      },
    ];

    expect(filterRenderableContentParts(parts)).toEqual([parts[1], parts[2]]);
  });

  it('hides routine GlassHive one-shot delegation rows from chat rendering', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_delegate',
          name: `worker_delegate_once${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output: '{"status":"dispatched","callback_ready":true,"user_status":"On it"}',
        },
      },
      { type: ContentTypes.TEXT, text: 'On ' },
      { type: ContentTypes.TEXT, text: 'it.' },
    ];

    expect(filterRenderableContentParts(parts)).toEqual([
      {
        type: ContentTypes.TEXT,
        text: 'On it.',
      },
    ]);
  });

  it('hides routine GlassHive one-shot rows when MCP output is wrapped in text content', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_delegate_wrapped',
          name: `worker_delegate_once${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output:
            '[{"type":"text","text":"{\\n  \\"status\\": \\"dispatched\\",\\n  \\"callback_ready\\": true,\\n  \\"user_status\\": \\"On it\\"\\n}"}]',
        },
      },
      { type: ContentTypes.TEXT, text: 'On it.' },
    ];

    expect(filterRenderableContentParts(parts)).toEqual([{ type: ContentTypes.TEXT, text: 'On it.' }]);
  });

  it('keeps blocked GlassHive one-shot delegation rows visible', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_delegate_blocked',
          name: `worker_delegate_once${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output: '{"status":"blocked","callback_ready":false,"user_status":"Callback is not configured."}',
        },
      },
      { type: ContentTypes.TEXT, text: 'I need callback setup first.' },
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });

  it('does not collapse similarly named non-canonical MCP servers', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_one',
          name: `worker_create${Constants.mcp_delimiter}not-glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
        },
      },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_two',
          name: `worker_run${Constants.mcp_delimiter}not-glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
        },
      },
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
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

describe('groupParallelContent', () => {
  it('keeps malformed non-array content empty instead of crashing', () => {
    expect(groupParallelContent(undefined)).toEqual({ parallelSections: [], sequentialParts: [] });
    expect(groupParallelContent(null)).toEqual({ parallelSections: [], sequentialParts: [] });
    expect(groupParallelContent('Legacy text message')).toEqual({
      parallelSections: [],
      sequentialParts: [],
    });
    expect(groupParallelContent({ type: ContentTypes.TEXT, text: 'Single part' })).toEqual({
      parallelSections: [],
      sequentialParts: [],
    });
  });
});
