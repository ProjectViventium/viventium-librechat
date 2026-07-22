/* === VIVENTIUM START ===
 * Feature: Voice call launch recovery copy.
 * Purpose: Convert structured server failures into concise, actionable public-safe UI text without
 * echoing raw response bodies, internal diagnostics, or private values.
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

type VoiceCallFailurePayload = {
  error?: unknown;
  reason?: unknown;
};

const GENERIC_FAILURE =
  'Voice could not start. Try again. If it keeps happening, check Viventium Status.';

function asFailurePayload(value: unknown): VoiceCallFailurePayload {
  return value != null && typeof value === 'object' ? (value as VoiceCallFailurePayload) : {};
}

export async function readVoiceCallFailureMessage(
  response: Pick<Response, 'status' | 'json'>,
): Promise<string> {
  let payload: VoiceCallFailurePayload = {};
  try {
    payload = asFailurePayload(await response.json());
  } catch {
    // Non-JSON and malformed responses deliberately fall through to public-safe recovery copy.
  }

  const error = typeof payload.error === 'string' ? payload.error : '';
  const reason = typeof payload.reason === 'string' ? payload.reason : '';

  if (error === 'voice_not_enabled') {
    return 'Voice is not enabled yet. Open Viventium from the menu bar to set it up.';
  }

  if (error === 'voice_runtime_not_ready') {
    if (
      reason === 'playground_identity_mismatch' ||
      reason === 'playground_source_unavailable' ||
      reason === 'playground_configuration_invalid'
    ) {
      return 'Voice needs attention. Open Viventium from the menu bar, check Status, then try again.';
    }
    return 'Voice is still starting. Wait a moment, then try again.';
  }

  if (response.status === 401) {
    return 'Your session expired. Refresh the page or sign in again, then try Voice.';
  }
  if (response.status === 403) {
    return 'This account cannot start Voice for this conversation.';
  }
  if (response.status === 404) {
    return 'This conversation changed. Refresh the page, then try Voice again.';
  }
  if (error === 'voice_agent_required') {
    return 'Choose an assistant before starting Voice.';
  }

  return GENERIC_FAILURE;
}
