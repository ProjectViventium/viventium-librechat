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

  it('keeps GlassHive worker orchestration rows visible when assistant text is present', () => {
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

    expect(filterRenderableContentParts(parts)).toEqual([
      parts[0],
      parts[1],
      {
        type: ContentTypes.TEXT,
        text: 'Done.',
      },
    ]);
  });

  it('keeps routine GlassHive one-shot delegation rows visible when the assistant already acknowledged dispatch', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_delegate',
          name: `worker_delegate_once${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output:
            '{"status":"dispatched","callback_ready":true,"acknowledgement_guidance":"Write one short acknowledgement in your own voice."}',
        },
      },
      { type: ContentTypes.TEXT, text: 'On ' },
      { type: ContentTypes.TEXT, text: 'it.' },
    ];

    expect(filterRenderableContentParts(parts)).toEqual([
      parts[0],
      {
        type: ContentTypes.TEXT,
        text: 'On it.',
      },
    ]);
  });

  it('hides runtime-hold no-response text parts without dropping cortex parts', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: '{NTA}',
        viventium_runtime_hold: true,
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'cortex_public_safe',
        name: 'Background Analysis',
        status: 'complete',
        insight: 'Visible background insight.',
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.TEXT,
        text: 'Follow-up text.',
      },
    ];

    expect(filterRenderableContentParts(parts)).toEqual([parts[1], parts[2]]);
  });

  it('keeps normal no-response text visible when it is not a runtime hold part', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: '{NTA}',
      },
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });

  it('hides late stream termination errors when assistant text already exists', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: 'Visible answer before the stream stopped.',
      },
      {
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]: 'An error occurred while processing the request: terminated',
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'cortex_public_safe',
        status: 'complete',
        insight: 'Background insight remains renderable.',
      } as unknown as TMessageContentParts,
    ];

    expect(filterRenderableContentParts(parts)).toEqual([parts[0], parts[2]]);
  });

  it('keeps error-only and non-termination error parts visible', () => {
    const terminatedOnly: TMessageContentParts[] = [
      {
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]: 'An error occurred while processing the request: terminated',
      } as unknown as TMessageContentParts,
    ];
    const nonTerminationAfterText: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'Partial answer.' },
      {
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]:
          'An error occurred while processing the request: status 429 rate_limit_error',
      } as unknown as TMessageContentParts,
    ];

    expect(filterRenderableContentParts(terminatedOnly)).toBe(terminatedOnly);
    expect(filterRenderableContentParts(nonTerminationAfterText)).toBe(nonTerminationAfterText);
  });

  it('hides structured recoverable provider errors after visible assistant text', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: 'Visible recovered answer.',
      },
      {
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]:
          'The model provider is temporarily overloaded. Please try again shortly.',
        error_class: 'provider_temporarily_unavailable',
      } as unknown as TMessageContentParts,
    ];

    expect(filterRenderableContentParts(parts)).toEqual([parts[0]]);
  });

  it('keeps structured recoverable provider errors visible when no assistant text exists', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]:
          'The model provider is temporarily overloaded. Please try again shortly.',
        error_class: 'provider_temporarily_unavailable',
      } as unknown as TMessageContentParts,
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });

  it('does not count runtime-hold no-response text as visible text for late termination hiding', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: '{NTA}',
        viventium_runtime_hold: true,
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]: 'An error occurred while processing the request: terminated',
      } as unknown as TMessageContentParts,
    ];

    expect(filterRenderableContentParts(parts)).toEqual([parts[1]]);
  });

  it('hides marked late termination errors without dropping surrounding cortex insight rows', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: 'Visible answer before the stream stopped.',
      },
      {
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'cortex_public_safe',
        status: 'complete',
        insight: 'Background insight remains renderable.',
      } as unknown as TMessageContentParts,
      {
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]:
          'An error occurred while processing the request: TypeError: terminated',
        error_class: 'late_stream_termination',
      } as unknown as TMessageContentParts,
    ];

    expect(filterRenderableContentParts(parts)).toEqual([parts[0], parts[1]]);
  });

  it('keeps unmarked abort shorthand after visible assistant text', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text: 'Visible answer before the stream stopped.',
      },
      {
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]: 'AbortError',
      } as unknown as TMessageContentParts,
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });

  it('keeps routine GlassHive one-shot rows visible when MCP output is wrapped in text content', () => {
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
            '[{"type":"text","text":"{\\n  \\"status\\": \\"dispatched\\",\\n  \\"callback_ready\\": true,\\n  \\"acknowledgement_guidance\\": \\"Write one short acknowledgement in your own voice.\\"\\n}"}]',
        },
      },
      { type: ContentTypes.TEXT, text: 'On it.' },
    ];

    expect(filterRenderableContentParts(parts)).toEqual(parts);
  });

  it('keeps routine GlassHive one-shot rows visible when no assistant acknowledgement exists', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_delegate_without_ack',
          name: `worker_delegate_once${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output:
            '{"status":"dispatched","callback_ready":true,"acknowledgement_guidance":"Write one short acknowledgement in your own voice."}',
        },
      },
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });

  it('keeps blocked GlassHive one-shot delegation rows inspectable', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_delegate_blocked',
          name: `worker_delegate_once${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output:
            '{"status":"blocked","callback_ready":false,"user_status":"Callback is not configured."}',
        },
      },
      { type: ContentTypes.TEXT, text: 'I need callback setup first.' },
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });

  it('keeps GlassHive workspace orchestration rows visible when assistant text is present', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_workspace_launch',
          name: `workspace_launch${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output: '{"workspace_id":"wrk_public_safe","status":"running"}',
        },
      },
      { type: ContentTypes.TEXT, text: 'I started the workspace.' },
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });

  it('keeps GlassHive browser/computer delegated task calls visible beside the final result', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_delegate_browser_task',
          name: `worker_delegate_once${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{"goal":"Open a public profile and report the follower count."}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output:
            '{"status":"completed","callback_ready":true,"output_text":"@example - 11.7K followers."}',
        },
      },
      {
        type: ContentTypes.TEXT,
        text: '@example - 11.7K followers. Profile is open in your browser.',
      },
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });

  it('keeps result-bearing GlassHive workspace wait rows inspectable when assistant text is skeletal', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_workspace_wait',
          name: `workspace_wait${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output:
            '{"terminal":true,"run_state":"completed","output_text":"Final worker answer with public-safe details."}',
        },
      },
      { type: ContentTypes.TEXT, text: 'Done.' },
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });

  it('sanitizes leaked raw GlassHive tool transcripts from assistant text', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text:
          'I started the workspace.\n' +
          'Tool: workspace_status {"workspace_id":"wrk_public_safe"}\n' +
          '<invoke name="workspace_wait"><parameter name="workspace_id">wrk_public_safe</parameter></invoke>\n' +
          '```json\n{"tool_call":{"name":"workspace_status","arguments":{"workspace_id":"wrk_public_safe"}}}\n```\n' +
          'I will report back when it finishes.',
      },
    ];

    expect(filterRenderableContentParts(parts)).toEqual([
      {
        type: ContentTypes.TEXT,
        text: 'I started the workspace.\nI will report back when it finishes.',
      },
    ]);
  });

  it('preserves ordinary JSON and XML examples that are not GlassHive tool transcripts', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text:
          'Example payload:\n' +
          '```json\n{"tool":"calculator","arguments":{"value":2}}\n```\n' +
          '<invoke name="example"><parameter name="value">2</parameter></invoke>',
      },
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });

  it('preserves non-GlassHive tool examples with run and project prefixes', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TEXT,
        text:
          'Tool: run_pipeline {"dryRun":true}\n' +
          '```json\n{"tool_call":{"name":"project_init","arguments":{"name":"demo"}}}\n```\n' +
          '<invoke name="project_init"><parameter name="name">demo</parameter></invoke>',
      },
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

  it('does not collapse distinct consecutive canonical GlassHive tool calls', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_live',
          name: `worker_live${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
        },
      },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_takeover',
          name: `worker_takeover${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
        },
      },
    ];

    expect(filterRenderableContentParts(parts)).toBe(parts);
  });

  it('collapses consecutive GlassHive launch retries to the latest user-facing row', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_workspace_launch_host_failed',
          name: `workspace_launch${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{"execution_mode":"host"}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output:
            'Error executing tool workspace_launch: host-native GlassHive workers are disabled',
        },
      },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_workspace_launch_workspace_dispatched',
          name: `workspace_launch${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{"execution_mode":"docker"}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 1,
          output:
            '{"status":"dispatched","view_steer_url":"https://example.com/watch/public-safe"}',
        },
      },
      { type: ContentTypes.TEXT, text: 'Started in GlassHive.' },
    ];

    expect(filterRenderableContentParts(parts)).toEqual([parts[1], parts[2]]);
  });

  it('keeps distinct same-name GlassHive tool calls inspectable', () => {
    const parts: TMessageContentParts[] = [
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_takeover_partial',
          name: `worker_takeover${Constants.mcp_delimiter}glasshive-workers-projects`,
          args: '{}',
          type: ToolCallTypes.TOOL_CALL,
          progress: 0.5,
        },
      },
      {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'toolu_takeover_final',
          name: `worker_takeover${Constants.mcp_delimiter}glasshive-workers-projects`,
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
