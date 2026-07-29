export enum ContentTypes {
  TEXT = 'text',
  THINK = 'think',
  TEXT_DELTA = 'text_delta',
  TOOL_CALL = 'tool_call',
  IMAGE_FILE = 'image_file',
  IMAGE_URL = 'image_url',
  VIDEO_URL = 'video_url',
  INPUT_AUDIO = 'input_audio',
  AGENT_UPDATE = 'agent_update',
  ERROR = 'error',
  /* === VIVENTIUM START === */
  /* Background Cortex Content Types */
  CORTEX_ACTIVATION = 'cortex_activation',
  CORTEX_BREWING = 'cortex_brewing',
  CORTEX_INSIGHT = 'cortex_insight',
  HARNESS_ACTIVITY = 'harness_activity',
  /* === VIVENTIUM END === */
}

/* === VIVENTIUM START === */
/**
 * Status of a background cortex during processing
 */
export type CortexStatus = 'activating' | 'brewing' | 'complete' | 'skipped' | 'error';

/**
 * Content part for cortex activation events
 */
export interface CortexContentPart {
  type: ContentTypes.CORTEX_ACTIVATION | ContentTypes.CORTEX_BREWING | ContentTypes.CORTEX_INSIGHT;
  cortex_id: string;
  cortex_name: string;
  status: CortexStatus;
  confidence?: number;
  reason?: string;
  insight?: string;
  error?: string;
  error_class?: string;
  errorClass?: string;
  silent?: boolean;
  no_response?: boolean;
  cortex_description?: string;
  activation_scope?: string | null;
  direct_action_surfaces?: unknown[];
  direct_action_surface_scopes?: unknown[];
  configured_tools?: number;
  completed_tool_calls?: number;
  status_changed_at?: string;
}

/** User-visible harness progress summaries. This must never contain hidden chain-of-thought. */
export interface HarnessActivityContentPart {
  type: ContentTypes.HARNESS_ACTIVITY;
  harness_activity: {
    event: 'queued' | 'started' | 'reasoning-summary' | 'plan' | 'tool' | 'file' | 'waiting';
    summary: string;
  };
}
/* === VIVENTIUM END === */
export enum StepTypes {
  TOOL_CALLS = 'tool_calls',
  MESSAGE_CREATION = 'message_creation',
}

export enum ToolCallTypes {
  FUNCTION = 'function',
  RETRIEVAL = 'retrieval',
  FILE_SEARCH = 'file_search',
  CODE_INTERPRETER = 'code_interpreter',
  /* Agents Tool Call */
  TOOL_CALL = 'tool_call',
}
