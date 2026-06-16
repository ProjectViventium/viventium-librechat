import { useMemo, useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { Button } from '@librechat/client';
import { TriangleAlert } from 'lucide-react';
import {
  Constants,
  dataService,
  actionDelimiter,
  actionDomainSeparator,
} from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';
import { useLocalize, useProgress } from '~/hooks';
import { AttachmentGroup } from './Parts';
import ToolCallInfo from './ToolCallInfo';
import ProgressText from './ProgressText';
import { GLASSHIVE_MCP_SERVER_NAME } from '~/utils/viventiumGlassHive';
import { logger, cn } from '~/utils';

// VIVENTIUM START: present GlassHive MCP worker tools with source-of-truth labels.
const GLASSHIVE_MCP_SERVER_NAMES = new Set([GLASSHIVE_MCP_SERVER_NAME]);
const GLASSHIVE_TOOL_LABELS: Record<string, string> = {
  projects_list: 'GlassHive projects',
  workspace_launch: 'GlassHive workspace',
  workspace_schedule: 'GlassHive schedule',
  workspace_status: 'GlassHive status',
  workspace_wait: 'GlassHive wait',
  workspace_continue: 'GlassHive continue',
  workspace_pause: 'GlassHive pause',
  workspace_resume: 'GlassHive resume',
  workspace_terminate: 'GlassHive terminate',
  workspace_artifacts: 'GlassHive artifacts',
  workspace_artifact_download: 'GlassHive artifact',
  workspace_preferences_get: 'GlassHive preferences',
  workspace_preferences_set: 'GlassHive preferences',
  worker_delegate_once: 'GlassHive delegate',
  workers_list: 'GlassHive projects',
  worker_create: 'GlassHive create',
  worker_find_or_resume: 'GlassHive resume',
  worker_get: 'GlassHive status',
  worker_live: 'GlassHive live',
  worker_run: 'GlassHive run',
  worker_message: 'GlassHive message',
  worker_pause: 'GlassHive pause',
  worker_resume: 'GlassHive resume',
  worker_interrupt: 'GlassHive interrupt',
  worker_terminate: 'GlassHive terminate',
  worker_desktop_action: 'GlassHive desktop',
  worker_takeover: 'GlassHive takeover',
  run_get: 'GlassHive run status',
  metrics_summary: 'GlassHive metrics',
};

function getUserFacingToolName(functionName: string, mcpServerName: string) {
  if (!functionName) {
    return '';
  }

  if (GLASSHIVE_MCP_SERVER_NAMES.has(mcpServerName) && GLASSHIVE_TOOL_LABELS[functionName]) {
    return GLASSHIVE_TOOL_LABELS[functionName];
  }
  if (GLASSHIVE_MCP_SERVER_NAMES.has(mcpServerName)) {
    return `GlassHive ${functionName.replace(/_/g, ' ')}`;
  }

  return functionName;
}

function safeGlassHiveText(value: unknown, maxLength = 240) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return '';
  }
  const cleaned = text
    .replace(/https?:\/\/[^\s<>)]+/gi, '[link]')
    .replace(
      /(?:\/Users|\/home|\/private\/var|\/var\/folders|\/tmp)\/[^\s`'"<>]+/g,
      '<local path>',
    );
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1).trimEnd()}...` : cleaned;
}

function safeGlassHiveFileLabel(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return '';
  }
  const withoutQuery = text.split(/[?#]/, 1)[0] ?? text;
  const parts = withoutQuery.split(/[\\/]/).filter(Boolean);
  return safeGlassHiveText(parts[parts.length - 1] || withoutQuery, 120);
}

function glassHiveProgressLabel(...values: unknown[]) {
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!text) {
      continue;
    }
    if (['complete', 'completed', 'success', 'succeeded', 'ready', 'done'].includes(text)) {
      return 'Completed';
    }
    if (
      [
        'accepted',
        'active',
        'created',
        'dispatched',
        'in_progress',
        'pending',
        'queued',
        'running',
        'scheduled',
        'started',
        'working',
      ].includes(text)
    ) {
      return 'In progress';
    }
    if (['blocked', 'error', 'failed', 'failure', 'needs_attention'].includes(text)) {
      return 'Needs attention';
    }
    if (['cancelled', 'canceled', 'stopped', 'terminated'].includes(text)) {
      return 'Stopped';
    }
    if (text === 'paused') {
      return 'Paused';
    }
  }
  return '';
}

function glassHiveArtifactLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      const record = item as Record<string, unknown>;
      return safeGlassHiveFileLabel(
        record.label ?? record.name ?? record.path ?? record.workspace_path,
      );
    })
    .filter(Boolean)
    .slice(0, 3);
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseGlassHiveStructuredValue(value?: string | null): Record<string, unknown> | undefined {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return undefined;
  }
  const direct = parseJsonObject(trimmed);
  if (direct) {
    return direct;
  }
  try {
    const wrapped = JSON.parse(trimmed);
    if (!Array.isArray(wrapped)) {
      return undefined;
    }
    for (const entry of wrapped) {
      const text = (entry as { text?: unknown })?.text;
      if (typeof text !== 'string') {
        continue;
      }
      const parsedText = parseJsonObject(text.trim());
      if (parsedText) {
        return parsedText;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function plainGlassHiveOutputText(value?: string | null) {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const text = parsed
        .map((entry) => {
          const entryText = (entry as { text?: unknown })?.text;
          if (typeof entryText !== 'string') {
            return '';
          }
          return parseJsonObject(entryText.trim()) ? '' : entryText.trim();
        })
        .filter(Boolean)
        .join('\n');
      return safeGlassHiveText(text, 800);
    }
    return '';
  } catch {
    return safeGlassHiveText(trimmed, 800);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstGlassHiveText(...values: unknown[]) {
  for (const value of values) {
    const text = safeGlassHiveText(value);
    if (text) {
      return text;
    }
  }
  return '';
}

function summarizeGlassHiveToolOutput(output?: string | null, input?: string | null) {
  const parsed = parseGlassHiveStructuredValue(output);
  const inputPayload = parseGlassHiveStructuredValue(input);
  const delegationAudit = objectValue(parsed?.delegation_audit);
  const followUpContext = objectValue(parsed?.follow_up_context);
  const viewSteer = objectValue(parsed?.view_steer);
  const lines: string[] = [];

  const taskTitle = firstGlassHiveText(
    delegationAudit?.title,
    parsed?.title,
    inputPayload?.description,
    inputPayload?.title,
    inputPayload?.goal,
    inputPayload?.request,
    inputPayload?.user_request,
  );
  if (taskTitle) {
    lines.push(`Task: ${taskTitle}`);
  }

  const progressLabel = glassHiveProgressLabel(
    parsed?.status,
    parsed?.state,
    parsed?.run_state,
    followUpContext?.run_state,
  );
  if (progressLabel) {
    lines.push(`Progress: ${progressLabel}`);
  }

  const resultText = firstGlassHiveText(
    parsed?.output_text,
    parsed?.message,
    parsed?.failure_user_message,
    parsed?.error,
  );
  if (resultText) {
    lines.push(resultText);
  }

  const viewUrl = firstGlassHiveText(parsed?.view_steer_url, viewSteer?.url, parsed?.view_url);
  if (viewUrl) {
    lines.push('View / Steer link available.');
  }

  const deliverable = objectValue(parsed?.deliverable);
  const deliverableLabel = safeGlassHiveFileLabel(
    deliverable?.label ?? deliverable?.name ?? deliverable?.path ?? deliverable?.workspace_path,
  );
  if (deliverableLabel) {
    lines.push(`Artifact: ${deliverableLabel}`);
  }

  const artifactLinks = objectValue(parsed?.artifact_links);
  const artifacts = objectValue(parsed?.artifacts);
  const artifactLabels = glassHiveArtifactLabels(artifactLinks?.items ?? artifacts?.items);
  if (artifactLabels.length > 0) {
    lines.push(`Artifacts: ${artifactLabels.join(', ')}`);
  }

  const plainText = plainGlassHiveOutputText(output);
  if (plainText) {
    lines.push(plainText);
  }

  if (lines.length > 0) {
    return lines.join('\n');
  }
  if (output?.trim()) {
    return 'GlassHive returned a result.';
  }
  return '';
}
// VIVENTIUM END

export default function ToolCall({
  initialProgress = 0.1,
  isLast = false,
  isSubmitting,
  name,
  args: _args = '',
  output,
  attachments,
  auth,
}: {
  initialProgress: number;
  isLast?: boolean;
  isSubmitting: boolean;
  name: string;
  args: string | Record<string, unknown>;
  output?: string | null;
  attachments?: TAttachment[];
  auth?: string;
  expires_at?: number;
}) {
  const localize = useLocalize();
  const [showInfo, setShowInfo] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | undefined>(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const prevShowInfoRef = useRef<boolean>(showInfo);

  const { function_name, domain, isMCPToolCall, mcpServerName } = useMemo(() => {
    if (typeof name !== 'string') {
      return { function_name: '', domain: null, isMCPToolCall: false, mcpServerName: '' };
    }
    if (name.includes(Constants.mcp_delimiter)) {
      const [func, server] = name.split(Constants.mcp_delimiter);
      return {
        function_name: func || '',
        domain: server && (server.replaceAll(actionDomainSeparator, '.') || null),
        isMCPToolCall: true,
        mcpServerName: server || '',
      };
    }
    const [func, _domain] = name.includes(actionDelimiter)
      ? name.split(actionDelimiter)
      : [name, ''];
    return {
      function_name: func || '',
      domain: _domain && (_domain.replaceAll(actionDomainSeparator, '.') || null),
      isMCPToolCall: false,
      mcpServerName: '',
    };
  }, [name]);

  // VIVENTIUM START: avoid exposing raw GlassHive function names in chat UI.
  const isGlassHiveToolCall = GLASSHIVE_MCP_SERVER_NAMES.has(mcpServerName);
  const displayFunctionName = useMemo(
    () => getUserFacingToolName(function_name, mcpServerName),
    [function_name, mcpServerName],
  );
  // VIVENTIUM END

  const actionId = useMemo(() => {
    if (isMCPToolCall || !auth) {
      return '';
    }
    try {
      const url = new URL(auth);
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const match = redirectUri.match(/\/api\/actions\/([^/]+)\/oauth\/callback/);
      return match?.[1] || '';
    } catch {
      return '';
    }
  }, [auth, isMCPToolCall]);

  const handleOAuthClick = useCallback(async () => {
    if (!auth) {
      return;
    }
    try {
      if (isMCPToolCall && mcpServerName) {
        await dataService.bindMCPOAuth(mcpServerName);
      } else if (actionId) {
        await dataService.bindActionOAuth(actionId);
      }
    } catch (e) {
      logger.error('Failed to bind OAuth CSRF cookie', e);
    }
    window.open(auth, '_blank', 'noopener,noreferrer');
  }, [auth, isMCPToolCall, mcpServerName, actionId]);

  const error =
    typeof output === 'string' && output.toLowerCase().includes('error processing tool');

  const args = useMemo(() => {
    if (typeof _args === 'string') {
      return _args;
    }
    try {
      return JSON.stringify(_args, null, 2);
    } catch (e) {
      logger.error(
        'client/src/components/Chat/Messages/Content/ToolCall.tsx - Failed to stringify args',
        e,
      );
      return '';
    }
  }, [_args]) as string | undefined;

  const glassHiveSummary = useMemo(
    () => (isGlassHiveToolCall ? summarizeGlassHiveToolOutput(output, args) : ''),
    [args, output, isGlassHiveToolCall],
  );

  const hasInfo = useMemo(
    () =>
      isGlassHiveToolCall
        ? glassHiveSummary.length > 0
        : (args?.length ?? 0) > 0 || (output?.length ?? 0) > 0,
    [args, output, isGlassHiveToolCall, glassHiveSummary],
  );

  const authDomain = useMemo(() => {
    const authURL = auth ?? '';
    if (!authURL) {
      return '';
    }
    try {
      const url = new URL(authURL);
      return url.hostname;
    } catch (e) {
      logger.error(
        'client/src/components/Chat/Messages/Content/ToolCall.tsx - Failed to parse auth URL',
        e,
      );
      return '';
    }
  }, [auth]);

  const progress = useProgress(initialProgress);
  const cancelled = (!isSubmitting && progress < 1) || error === true;

  const getFinishedText = () => {
    if (cancelled) {
      return localize('com_ui_cancelled');
    }
    if (isMCPToolCall === true) {
      return localize('com_assistants_completed_function', { 0: displayFunctionName });
    }
    if (domain != null && domain && domain.length !== Constants.ENCODED_DOMAIN_LENGTH) {
      return localize('com_assistants_completed_action', { 0: domain });
    }
    return localize('com_assistants_completed_function', { 0: displayFunctionName });
  };

  useLayoutEffect(() => {
    if (showInfo !== prevShowInfoRef.current) {
      prevShowInfoRef.current = showInfo;
      setIsAnimating(true);

      if (showInfo && contentRef.current) {
        requestAnimationFrame(() => {
          if (contentRef.current) {
            const height = contentRef.current.scrollHeight;
            setContentHeight(height + 4);
          }
        });
      } else {
        setContentHeight(0);
      }

      const timer = setTimeout(() => {
        setIsAnimating(false);
      }, 400);

      return () => clearTimeout(timer);
    }
  }, [showInfo]);

  useEffect(() => {
    if (!contentRef.current) {
      return;
    }
    const resizeObserver = new ResizeObserver((entries) => {
      if (showInfo && !isAnimating) {
        for (const entry of entries) {
          if (entry.target === contentRef.current) {
            setContentHeight(entry.contentRect.height + 4);
          }
        }
      }
    });
    resizeObserver.observe(contentRef.current);
    return () => {
      resizeObserver.disconnect();
    };
  }, [showInfo, isAnimating]);

  if (!isLast && (!function_name || function_name.length === 0) && !output) {
    return null;
  }

  return (
    <>
      <div className="relative my-2.5 flex min-h-5 min-w-0 shrink-0 items-center gap-2.5">
        <ProgressText
          progress={progress}
          onClick={() => setShowInfo((prev) => !prev)}
          inProgressText={
            displayFunctionName
              ? localize('com_assistants_running_var', { 0: displayFunctionName })
              : localize('com_assistants_running_action')
          }
          authText={
            !cancelled && authDomain.length > 0 ? localize('com_ui_requires_auth') : undefined
          }
          finishedText={getFinishedText()}
          hasInput={hasInfo}
          isExpanded={showInfo}
          error={cancelled}
        />
      </div>
      <div
        className="relative"
        style={{
          height: showInfo ? contentHeight : 0,
          overflow: 'hidden',
          transition:
            'height 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          opacity: showInfo ? 1 : 0,
          transformOrigin: 'top',
          willChange: 'height, opacity',
          perspective: '1000px',
          backfaceVisibility: 'hidden',
          WebkitFontSmoothing: 'subpixel-antialiased',
        }}
      >
        <div
          className={cn(
            'overflow-hidden rounded-xl border border-border-light bg-surface-secondary shadow-md',
            showInfo && 'shadow-lg',
          )}
          style={{
            transform: showInfo ? 'translateY(0) scale(1)' : 'translateY(-8px) scale(0.98)',
            opacity: showInfo ? 1 : 0,
            transition:
              'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div ref={contentRef}>
            {showInfo && hasInfo && (
              <ToolCallInfo
                key="tool-call-info"
                input={isGlassHiveToolCall ? '' : (args ?? '')}
                output={isGlassHiveToolCall ? glassHiveSummary : output}
                domain={authDomain || (domain ?? '')}
                function_name={displayFunctionName}
                pendingAuth={authDomain.length > 0 && !cancelled && progress < 1}
                attachments={attachments}
              />
            )}
          </div>
        </div>
      </div>
      {auth != null && auth && progress < 1 && !cancelled && (
        <div className="flex w-full flex-col gap-2.5">
          <div className="mb-1 mt-2">
            <Button
              className="font-mediu inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm"
              variant="default"
              rel="noopener noreferrer"
              onClick={handleOAuthClick}
            >
              {localize('com_ui_sign_in_to_domain', { 0: authDomain })}
            </Button>
          </div>
          <p className="flex items-center text-xs text-text-warning">
            <TriangleAlert className="mr-1.5 inline-block h-4 w-4" aria-hidden="true" />
            {localize('com_assistants_allow_sites_you_trust')}
          </p>
        </div>
      )}
      {attachments && attachments.length > 0 && <AttachmentGroup attachments={attachments} />}
    </>
  );
}
