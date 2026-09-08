/* === VIVENTIUM START === Current native tool records stay bound to their accepted response. === */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import { nativeResponseDigest } from '@librechat/data-schemas';
import type { TMessage } from 'librechat-data-provider';
import type {
  NativeResponseIdentity,
  NativeResponseMessageProjection,
  NativeResponseCandidate,
  NativeResponseAdmission,
} from '@librechat/data-schemas';

const TOOL_OUTPUT_BYTES = 12 * 1024;
const REPLAY_BYTES = 192 * 1024;
const boundedText = z
  .object({
    redacted: z.boolean().default(false),
    text: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    omitted_bytes: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => {
    const bytes = Buffer.byteLength(value.text);
    return (
      bytes <= TOOL_OUTPUT_BYTES &&
      bytes + value.omitted_bytes === value.bytes &&
      (value.omitted_bytes !== 0 ||
        createHash('sha256').update(value.text).digest('hex') === value.sha256)
    );
  });
const resultSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    status: z.enum(['completed', 'failed', 'cancelled']),
    arguments: boundedText,
    output: boundedText,
    exit_code: z.number().int().optional(),
  })
  .strict();
const evidenceSchema = z
  .object({
    version: z.literal(1),
    owner_id: z.string().min(1),
    conversation_id: z.string().min(1),
    message_id: z.string().min(1),
    invocation_id: z.string().min(1),
    request_id: z.string().min(1),
    run_id: z.string().min(1),
    results: z.array(resultSchema),
    omitted_results: z.number().int().nonnegative(),
    excluded_log_prefix_bytes: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value.results)) <= REPLAY_BYTES &&
      new Set(value.results.map((result) => result.id)).size === value.results.length,
  );
const boundEvidenceSchema = z
  .object({
    evidence: evidenceSchema,
    logicalTurnId: z.string().min(1),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type NativeToolEvidence = z.infer<typeof boundEvidenceSchema>;
type NativeEvidenceResponse = {
  id?: string;
  glasshive?: { request_id?: string; tool_evidence?: unknown };
};

/** Used only by the canonical native response projector, after its source/commit checks. */
export function projectNativeToolEvidence(
  identity: Pick<
    NativeResponseIdentity,
    | 'userId'
    | 'conversationId'
    | 'responseMessageId'
    | 'invocationId'
    | 'logicalTurnId'
    | 'revision'
  >,
  response: NativeEvidenceResponse,
  message: NativeResponseMessageProjection,
  candidate?: Pick<NativeResponseCandidate, 'requestId' | 'runId'>,
): NativeResponseMessageProjection {
  const original = message.metadata?.viventium;
  const viventium: Record<string, unknown> =
    original && typeof original === 'object' ? { ...original } : {};
  const metadata = { ...message.metadata, viventium };
  delete metadata.viventium.nativeToolEvidence;
  const supplied = response.glasshive?.tool_evidence;
  if (supplied == null) return { ...message, metadata };
  const parsed = evidenceSchema.safeParse(supplied);
  if (!parsed.success) throw new Error('native_tool_evidence_invalid');
  const evidence = parsed.data;
  if (
    evidence.owner_id !== identity.userId ||
    evidence.conversation_id !== identity.conversationId ||
    evidence.message_id !== identity.responseMessageId ||
    evidence.invocation_id !== identity.invocationId ||
    evidence.run_id !== candidate?.runId ||
    evidence.request_id !== candidate?.requestId ||
    evidence.request_id !== response.id ||
    evidence.request_id !== response.glasshive?.request_id
  ) {
    throw new Error('native_tool_evidence_identity_mismatch');
  }
  metadata.viventium.nativeToolEvidence = {
    evidence,
    logicalTurnId: identity.logicalTurnId,
    revision: identity.revision,
  } satisfies NativeToolEvidence;
  return { ...message, metadata };
}

type EvidenceMessage = Pick<TMessage, 'messageId' | 'conversationId'> & {
  user?: string;
  metadata?: {
    viventium?: {
      nativeToolEvidence?: unknown;
      interactionContext?: { logical_turn_id?: string; revision?: number };
    };
  };
};

export function nativeToolEvidenceForMemory(
  message: EvidenceMessage,
  admission?: Pick<
    NativeResponseAdmission,
    | 'userId'
    | 'conversationId'
    | 'responseMessageId'
    | 'invocationId'
    | 'logicalTurnId'
    | 'revision'
    | 'status'
    | 'candidateSha256'
    | 'candidateJson'
  >,
): NonNullable<TMessage['content']> {
  const supplied = message.metadata?.viventium?.nativeToolEvidence;
  if (supplied == null) return [];
  const parsed = boundEvidenceSchema.safeParse(supplied);
  if (!parsed.success) throw new Error('native_tool_evidence_invalid');
  if (admission?.status !== 'completed' || !admission.candidateJson || !admission.candidateSha256) {
    throw new Error('native_tool_evidence_admission_missing');
  }
  const candidate = JSON.parse(admission.candidateJson) as NativeResponseCandidate;
  if (nativeResponseDigest(candidate) !== admission.candidateSha256) {
    throw new Error('native_tool_evidence_candidate_mismatch');
  }
  const canonical = projectNativeToolEvidence(
    admission,
    JSON.parse(candidate.responseJson),
    {},
    candidate,
  );
  const canonicalMetadata = canonical.metadata?.viventium;
  const canonicalEvidence =
    canonicalMetadata &&
    typeof canonicalMetadata === 'object' &&
    'nativeToolEvidence' in canonicalMetadata
      ? canonicalMetadata.nativeToolEvidence
      : undefined;
  if (JSON.stringify(canonicalEvidence) !== JSON.stringify(parsed.data)) {
    throw new Error('native_tool_evidence_candidate_mismatch');
  }
  const { evidence, logicalTurnId, revision } = parsed.data;
  const context = message.metadata?.viventium?.interactionContext;
  if (
    evidence.owner_id !== String(message.user) ||
    evidence.conversation_id !== message.conversationId ||
    evidence.message_id !== message.messageId ||
    (context && (context.logical_turn_id !== logicalTurnId || context.revision !== revision))
  ) {
    throw new Error('native_tool_evidence_identity_mismatch');
  }
  const coverage = {
    native_tool_evidence: {
      run_id: evidence.run_id,
      request_id: evidence.request_id,
      results: evidence.results.length,
      omitted_results: evidence.omitted_results,
      excluded_log_prefix_bytes: evidence.excluded_log_prefix_bytes,
    },
  };
  return [
    {
      type: ContentTypes.TEXT,
      text: JSON.stringify(coverage),
      tool_call_ids: evidence.results.map((result) => result.id),
    },
    ...evidence.results.map(
      (result) =>
        ({
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            type: ToolCallTypes.TOOL_CALL,
            id: result.id,
            name: result.name,
            args: JSON.stringify({ native_arguments: result.arguments }),
            output: JSON.stringify({
              call_id: result.id,
              name: result.name,
              arguments: result.arguments,
              status: result.status,
              exit_code: result.exit_code,
              result: result.output,
              run_id: evidence.run_id,
              request_id: evidence.request_id,
              evidence_window: {
                omitted_results: evidence.omitted_results,
                excluded_log_prefix_bytes: evidence.excluded_log_prefix_bytes,
              },
            }),
          },
        }) as const,
    ),
  ];
}
const graphRequestSchema = z
  .object({
    request_id: z.string().min(1),
    run_id: z.string().min(1),
    agent_id: z.string().min(1),
    state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    instruction_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    authority_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    evidence_available: z.boolean(),
    results: z.array(resultSchema),
    omitted_results: z.number().int().nonnegative(),
    excluded_log_prefix_bytes: z.number().int().nonnegative(),
  })
  .strict()
  .refine((item) => new Set(item.results.map((result) => result.id)).size === item.results.length);
const graphEvidenceSchema = z
  .object({
    version: z.literal(1),
    owner_id: z.string().min(1),
    conversation_id: z.string().min(1),
    message_id: z.string().min(1),
    stream_id: z.string().min(1),
    anchor_invocation_id: z.string().min(1),
    main_context_snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    context_epoch: z.string().regex(/^[a-f0-9]{64}$/),
    logical_turn_id: z.string().min(1),
    logical_turn_revision: z.number().int().positive(),
    requests: z.array(graphRequestSchema).max(128),
    omitted_requests: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (evidence) =>
      Buffer.byteLength(JSON.stringify(evidence.requests)) <= REPLAY_BYTES &&
      new Set(evidence.requests.map((item) => item.request_id)).size === evidence.requests.length &&
      new Set(evidence.requests.map((item) => item.run_id)).size === evidence.requests.length,
  );

/** Called only with the existing authenticated saved-result reader's exact invocation response. */
export function nativeGraphToolEvidenceContent(
  identity: NativeResponseIdentity,
  supplied: unknown,
) {
  if (supplied == null) return [];
  const parsed = graphEvidenceSchema.safeParse(supplied);
  if (!parsed.success) throw new Error('native_graph_tool_evidence_invalid');
  const evidence = parsed.data;
  if (
    evidence.owner_id !== identity.userId ||
    evidence.conversation_id !== identity.conversationId ||
    evidence.message_id !== identity.responseMessageId ||
    evidence.stream_id !== identity.streamId ||
    evidence.anchor_invocation_id !== identity.invocationId ||
    evidence.logical_turn_id !== identity.logicalTurnId ||
    evidence.logical_turn_revision !== identity.revision
  ) {
    throw new Error('native_graph_tool_evidence_identity_mismatch');
  }
  return [{ type: 'text' as const, text: JSON.stringify({ native_tool_evidence: evidence }) }];
}
export function nativeToolEvidenceUnavailableContent(
  identity: NativeResponseIdentity,
  reason: 'saved_result_missing' | 'graph_evidence_missing',
) {
  return [
    {
      type: 'text' as const,
      text: JSON.stringify({
        native_tool_evidence: {
          evidence_available: false,
          reason,
          anchor_invocation_id: identity.invocationId,
          message_id: identity.responseMessageId,
          logical_turn_id: identity.logicalTurnId,
          logical_turn_revision: identity.revision,
        },
      }),
    },
  ];
}
/* === VIVENTIUM END === */
