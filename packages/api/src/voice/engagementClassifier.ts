/* === VIVENTIUM START ===
 * Feature: Read-only semantic Wing engagement classification.
 * Purpose: Own exact input, configured-route fallback, fresh-authority revalidation, trace facts,
 * and attestation issuance without launching an Agent controller or any external action.
 * === VIVENTIUM END === */

import crypto from 'node:crypto';
import { safeErrorCode } from '../logging/safeError';

type UnknownRecord = Record<string, unknown>;

export interface VoiceSemanticClassificationInput {
  provider: unknown;
  model: unknown;
  utterance: string;
  callSessionId: string;
  turnId: string;
  timeoutMs: number;
  promptRef: 'surface.wing';
  requestContext?: unknown;
  suppressBackgroundCortices: true;
  canAuthorizeSideEffects: false;
}

export interface VoiceEngagementClassifierDependencies {
  canonicalVoiceOwnerUtterance(segments: unknown): string | null;
  canonicalVoiceSessionMode(session: unknown): string;
  createVoiceEngagementAttestation(input: UnknownRecord): unknown;
  finalizedOwnerSpeakerAuthority(segments: unknown, session: unknown): boolean;
  getCallSessionVoiceSettings(callSessionId: string): Promise<unknown>;
  getVoiceClassifierFaultControlContext(): UnknownRecord;
  latestPersistedVoiceTurnAuthority(input: UnknownRecord): Promise<unknown>;
  listSpeakerSegments(input: { callSessionId: string; limit: number }): Promise<unknown>;
  logger: { warn(message: string, fields: UnknownRecord): void };
  matchesCanonicalVoiceOwnerUtterance(segments: unknown, utterance: unknown): boolean;
  now(): number;
  recordVoiceOrchestrationTrace(input: UnknownRecord): Promise<unknown>;
  recordVoiceOrchestrationTraceBestEffort(input: UnknownRecord): Promise<unknown>;
  runSemanticClassification(input: VoiceSemanticClassificationInput): Promise<unknown>;
  runVoiceClassifierFaultControl(input: UnknownRecord): Promise<unknown>;
}

export interface VoiceEngagementClassificationRequest {
  body?: unknown;
  query?: unknown;
  session?: unknown;
  user?: unknown;
  requestContext?: unknown;
}

export interface VoiceEngagementClassificationResponse {
  status: number;
  body: UnknownRecord;
}

const BODY_KEYS = new Set(['version', 'callSessionId', 'turnId', 'segmentIds']);

function recordFrom(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function recordsFrom(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(recordFrom) : [];
}

function notAuthorized(): VoiceEngagementClassificationResponse {
  return {
    status: 403,
    body: {
      code: 'voice_engagement_not_authorized',
      message: 'This voice turn cannot authorize an action.',
      retryable: false,
    },
  };
}

function unavailable(message: string): VoiceEngagementClassificationResponse {
  return {
    status: 503,
    body: { code: 'voice_engagement_unavailable', message, retryable: true },
  };
}

function voiceProviderAttemptStatus(attempt: unknown): string {
  const value = recordFrom(attempt);
  const error = recordFrom(value.error);
  if (value.status === 'completed') return 'completed';
  if (value.preModel === true && error.class === 'provider_temporarily_unavailable') {
    return 'pre_model_unavailable';
  }
  const errorClass = String(error.class || error.code || '').trim();
  if (errorClass === 'provider_timeout' || errorClass === 'ABORT_ERR') return 'timeout';
  if (errorClass === 'provider_rate_limited') return 'rate_limited';
  if (errorClass === 'provider_unauthorized' || Number(error.status) === 401) {
    return 'unauthorized';
  }
  if (errorClass === 'cancelled' || errorClass === 'AbortError') return 'cancelled';
  return 'failed';
}

function isExactMpv054SyntheticOwner(user: unknown): boolean {
  const value = recordFrom(user);
  const email = String(value.email || '')
    .trim()
    .toLowerCase();
  return Boolean(
    value.name === 'Viventium Voice QA' &&
    value.provider === 'local' &&
    /^viventium-voice-qa-mpv-061-[a-z0-9-]{1,80}@example\.com$/.test(email),
  );
}

function exactRequestBody(body: UnknownRecord): boolean {
  const keys = Object.keys(body);
  return (
    keys.length >= 3 &&
    keys.length <= 4 &&
    keys.every((key) => BODY_KEYS.has(key)) &&
    (body.segmentIds === undefined || Array.isArray(body.segmentIds))
  );
}

export function createVoiceEngagementClassifierService(
  deps: VoiceEngagementClassifierDependencies,
) {
  async function recordQaTrace(input: UnknownRecord): Promise<void> {
    try {
      await deps.recordVoiceOrchestrationTrace(input);
    } catch {
      throw Object.assign(new Error('Voice classifier QA trace unavailable'), {
        code: 'voice_classifier_qa_trace_unavailable',
      });
    }
  }

  async function classify(
    input: VoiceEngagementClassificationRequest,
  ): Promise<VoiceEngagementClassificationResponse> {
    const body = recordFrom(input.body);
    const session = recordFrom(input.session);
    const user = recordFrom(input.user);
    const turnId = typeof body.turnId === 'string' ? body.turnId.trim() : '';
    if (
      Object.keys(recordFrom(input.query)).length > 0 ||
      !exactRequestBody(body) ||
      body.version !== 1 ||
      body.callSessionId !== session.callSessionId ||
      !turnId ||
      turnId.length > 160 ||
      turnId.includes('\0') ||
      deps.canonicalVoiceSessionMode(session) !== 'wing'
    ) {
      return notAuthorized();
    }

    try {
      const stored = await deps.listSpeakerSegments({
        callSessionId: String(session.callSessionId),
        limit: 512,
      });
      const segments = recordsFrom(stored)
        .filter((segment) => segment.turnId === turnId)
        .sort(
          (left, right) =>
            Number(left.sequence || 0) - Number(right.sequence || 0) ||
            String(left.segmentId).localeCompare(String(right.segmentId)),
        );
      const segmentIds = segments.map((segment) => segment.segmentId);
      const classifiedUtterance = deps.canonicalVoiceOwnerUtterance(segments);
      const requestedSegmentIds = body.segmentIds;
      if (
        !deps.finalizedOwnerSpeakerAuthority(segments, session) ||
        !classifiedUtterance ||
        (requestedSegmentIds !== undefined &&
          (!Array.isArray(requestedSegmentIds) ||
            requestedSegmentIds.length !== segmentIds.length ||
            requestedSegmentIds.some((segmentId, index) => segmentId !== segmentIds[index])))
      ) {
        return notAuthorized();
      }

      const settings = recordFrom(
        await deps.getCallSessionVoiceSettings(String(session.callSessionId)),
      );
      const assistantRoute = recordFrom(settings.assistantRoute);
      const effective = recordFrom(assistantRoute.effective);
      if (!effective.provider || !effective.model) {
        return unavailable('The configured voice assistant is unavailable.');
      }
      const fallback = recordFrom(assistantRoute.fallbackLlm);
      const configuredRoutes = [effective];
      if (
        fallback.provider &&
        fallback.model &&
        (fallback.provider !== effective.provider || fallback.model !== effective.model)
      ) {
        configuredRoutes.push(fallback);
      }

      const classificationDeadline = deps.now() + 7_800;
      const observedProviderAttempts: UnknownRecord[] = [];
      let firstConfiguredRouteIndex = 0;
      let controlledPrimaryReceipt: UnknownRecord | null = null;
      if (isExactMpv054SyntheticOwner(user) && configuredRoutes.length === 2) {
        const context = deps.getVoiceClassifierFaultControlContext();
        const controlResult = recordFrom(
          await deps.runVoiceClassifierFaultControl({
            caseId: 'MPV-061',
            sessionRef: context.sessionRef,
            candidateDigest: context.candidateDigest,
            componentArtifactDigest: context.componentArtifactDigest,
            installedArtifactDigest: context.installedArtifactDigest,
            runtimeOwnerBindingHash: context.runtimeOwnerBindingHash,
            ownerId: user.id,
            callSessionId: session.callSessionId,
            turnId,
            segments: segments.map((segment) => ({
              segmentId: segment.segmentId,
              revision: Number(segment.revision),
            })),
            utteranceHash: `sha256:${crypto
              .createHash('sha256')
              .update(classifiedUtterance, 'utf8')
              .digest('hex')}`,
            primary: { provider: effective.provider, model: effective.model },
            fallback: { provider: fallback.provider, model: fallback.model },
          }),
        );
        if (controlResult.consumed === true) {
          controlledPrimaryReceipt = controlResult;
          firstConfiguredRouteIndex = 1;
          observedProviderAttempts.push({
            provider: effective.provider,
            model: effective.model,
            status: 'error',
            error: { class: 'provider_temporarily_unavailable' },
            failure: controlResult.failure,
            preModel: true,
            receiptRef: controlResult.receiptDigest,
            attemptRole: 'primary',
            attemptNumber: 1,
          });
          await recordQaTrace({
            ownerId: user.id,
            callSessionId: session.callSessionId,
            turnId,
            eventRef: controlResult.controlId,
            stage: 'attempt.history.complete',
            facts: {
              attemptRef: `engagement:${turnId}:primary:1`,
              attemptNumber: 1,
              provider: effective.provider,
              model: effective.model,
              state: 'failed',
              providerStatus: 'failed',
              attemptRole: 'primary',
              failure: controlResult.failure,
              preModel: true,
              primaryStartedCount: 0,
              primaryCompletedCount: 0,
              providerHealthMutationCount: 0,
              providerHealthSuppressed: false,
              receiptRef: controlResult.receiptDigest,
              effectCount: 1,
            },
          });
        }
      }

      let result: UnknownRecord = {};
      for (let index = firstConfiguredRouteIndex; index < configuredRoutes.length; index += 1) {
        const route = configuredRoutes[index];
        const remainingMs = classificationDeadline - deps.now();
        if (remainingMs <= 0) break;
        const reservedFallbackMs = index < configuredRoutes.length - 1 ? 1_500 : 0;
        const timeoutMs = Math.max(1, remainingMs - reservedFallbackMs);
        if (index > 0) {
          deps.logger.warn('[VIVENTIUM][voice/engagement] using configured provider fallback', {
            code: 'configured_provider_fallback',
            provider: route.provider,
            model: route.model,
          });
        }
        if (controlledPrimaryReceipt && index === 1) {
          const fallbackAttemptRef = `engagement:${turnId}:fallback:2`;
          await recordQaTrace({
            ownerId: user.id,
            callSessionId: session.callSessionId,
            turnId,
            eventRef: fallbackAttemptRef,
            stage: 'provider.request.forwarded',
            facts: {
              attemptRef: fallbackAttemptRef,
              providerRequestRef: fallbackAttemptRef,
              attemptNumber: 2,
              provider: route.provider,
              model: route.model,
              state: 'running',
              attemptRole: 'fallback',
              configuredFallback: true,
              receiptRef: controlledPrimaryReceipt.receiptDigest,
              effectCount: 1,
            },
          });
        }
        result = recordFrom(
          await deps.runSemanticClassification({
            provider: route.provider,
            model: route.model,
            utterance: classifiedUtterance,
            callSessionId: String(session.callSessionId),
            turnId,
            timeoutMs,
            promptRef: 'surface.wing',
            requestContext: input.requestContext,
            suppressBackgroundCortices: true,
            canAuthorizeSideEffects: false,
          }),
        );
        const providerAttempts = recordsFrom(result.providerAttempts);
        observedProviderAttempts.push(
          ...providerAttempts.map((attempt) => ({
            ...attempt,
            attemptRole: index === 0 ? 'primary' : 'fallback',
            attemptNumber: index + 1,
          })),
        );
        if (providerAttempts.some((attempt) => attempt.status === 'completed')) break;
      }

      if (!observedProviderAttempts.some((attempt) => attempt.status === 'completed')) {
        const authenticationFailure = [...observedProviderAttempts].reverse().find((attempt) => {
          const error = recordFrom(attempt.error);
          return (
            error.class === 'provider_unauthorized' ||
            error.status === 401 ||
            error.code === 'INVALID_API_KEY'
          );
        });
        if (authenticationFailure) {
          return {
            status: 503,
            body: {
              code: 'provider_failure',
              failure: 'provider_unauthorized',
              provider: authenticationFailure.provider,
              model: authenticationFailure.model,
              message: 'The configured voice provider rejected its credentials.',
              retryable: false,
            },
          };
        }
        return unavailable('The voice engagement check could not complete.');
      }

      const current = recordFrom(
        await deps.latestPersistedVoiceTurnAuthority({
          session,
          userId: user.id,
          turnId,
          expectedSegments: segments,
        }),
      );
      const currentSession = recordFrom(current.session);
      const currentSegments = recordsFrom(current.segments);
      if (
        !Object.keys(current).length ||
        current.complete !== true ||
        current.revisionChanged === true ||
        deps.canonicalVoiceSessionMode(currentSession) !== 'wing' ||
        !deps.finalizedOwnerSpeakerAuthority(currentSegments, currentSession) ||
        !deps.matchesCanonicalVoiceOwnerUtterance(currentSegments, classifiedUtterance)
      ) {
        return notAuthorized();
      }

      const completedAttempts = observedProviderAttempts.filter(
        (attempt) => attempt.status === 'completed',
      );
      for (const attempt of completedAttempts) {
        const attemptRef = `engagement:${turnId}:${attempt.attemptRole}:${attempt.attemptNumber}`;
        await deps.recordVoiceOrchestrationTraceBestEffort({
          ownerId: user.id,
          callSessionId: currentSession.callSessionId,
          turnId,
          eventRef: attemptRef,
          stage: 'provider.attempt.completed',
          facts: {
            attemptRef,
            attemptNumber: attempt.attemptNumber,
            provider: attempt.provider,
            model: attempt.model,
            providerStatus: 'completed',
            attemptRole: attempt.attemptRole,
            effectCount: 1,
          },
        });
      }
      const completedFallback = completedAttempts.find(
        (attempt) => attempt.attemptRole === 'fallback',
      );
      if (completedFallback) {
        const primaryAttempt = observedProviderAttempts.find(
          (attempt) => attempt.attemptRole === 'primary',
        );
        const primaryAttemptRef = `engagement:${turnId}:primary:1`;
        const fallbackAttemptRef = `engagement:${turnId}:fallback:${completedFallback.attemptNumber}`;
        await deps.recordVoiceOrchestrationTraceBestEffort({
          ownerId: user.id,
          callSessionId: currentSession.callSessionId,
          turnId,
          eventRef: fallbackAttemptRef,
          stage: 'provider.fallback.completed',
          facts: {
            primaryAttemptRef,
            fallbackAttemptRef,
            primaryProvider: primaryAttempt?.provider,
            primaryModel: primaryAttempt?.model,
            primaryProviderStatus:
              voiceProviderAttemptStatus(primaryAttempt) === 'pre_model_unavailable'
                ? 'failed'
                : voiceProviderAttemptStatus(primaryAttempt),
            fallbackProvider: completedFallback.provider,
            fallbackModel: completedFallback.model,
            fallbackProviderStatus: 'completed',
            configuredFallback: true,
            requiredCapabilitiesPreserved: true,
            effectCount: 1,
          },
        });
      }

      return {
        status: 200,
        body: recordFrom(
          deps.createVoiceEngagementAttestation({
            callSessionId: currentSession.callSessionId,
            turnId,
            participantIdentity: currentSession.ownerParticipantIdentity,
            segmentIds: currentSegments.map((segment) => segment.segmentId),
            directlyAddressed: result.shouldActivate === true,
            revision: Math.max(
              ...currentSegments.map((segment) => Number(segment.revision || 0)),
              1,
            ),
            utterance: classifiedUtterance,
          }),
        ),
      };
    } catch (error) {
      const code = safeErrorCode(error, 'classification_failed');
      deps.logger.warn('[VIVENTIUM][voice/engagement] classification failed', { code });
      if (code.startsWith('voice_classifier_qa_')) {
        return {
          status: 503,
          body: {
            code: 'voice_classifier_qa_control_unavailable',
            message: 'The local Voice QA control could not complete.',
            retryable: true,
          },
        };
      }
      return unavailable('The voice engagement check could not complete.');
    }
  }

  return { classify };
}

/* === VIVENTIUM END === */
