/* === VIVENTIUM START === Isolated appraisal transport retains trusted provenance and no user tools. === */
import { getTrustedInteractionContext, getTrustedAdapterCapabilities, getTrustedDeliveryPolicy,
  setTrustedInteractionContext } from '../agents/interactionContext';

type UnknownRecord = Record<string, any>;
export function createFeelingReactionRequest(request: UnknownRecord, userText: string) {
  const isolated = Object.create(request);
  isolated.body = { conversationId: request.body?.conversationId, files: [], text: userText };
  isolated.user = { ...request.user, personalization: { ...request.user?.personalization,
    memories: false, conversation_recall: false } };
  // The appraiser reads the typed state once in its JSON input. It must not receive a capsule
  // describing the same state as behavioral instructions, or acquire Voice presentation tools.
  isolated._viventiumFeelingSnapshot = null;
  isolated._viventiumGlassHiveWorkerFeelings = '';
  isolated._viventiumGlassHiveWorkerFeelingsEnabled = false;
  isolated._viventiumGlassHiveWorkerFeelingsHash = '';
  isolated._viventiumGlassHiveWorkerFeelingsScope = 'disabled';
  isolated._viventiumGlassHiveWorkerFeelingsRangePromptOverrideCount = 0;
  isolated._viventiumGlassHiveWorkerFeelingsActiveRangePromptOverrideCount = 0;
  isolated._viventiumGlassHiveWorkerFeelingsActiveRangePromptOverrideChars = 0;
  isolated._viventiumGlassHiveWorkerMemory = '';
  isolated._viventiumNativeResponseIdentity = null;
  // Main pins this slot as non-writable. Define an own slot rather than assigning through
  // that inherited descriptor, so the detached appraiser keeps its independent carrier.
  Object.defineProperty(isolated, '_viventiumMainContextSnapshotV1', {
    value: null, writable: true, configurable: true, enumerable: false,
  });
  isolated.viventiumVoiceWorkAuthority = null;
  isolated.viventiumCallSession = null;
  isolated._viventiumProviderModelReceipts = new Map();
  const context = getTrustedInteractionContext(request);
  if (context) setTrustedInteractionContext(isolated, context,
    getTrustedAdapterCapabilities(request) || undefined,
    getTrustedDeliveryPolicy(request) || undefined);
  return isolated;
}

export function feelingReactionNativeOptions(provider: string, workspace?: UnknownRecord) {
  if (provider !== 'glasshive-harness') return {};
  return { viventiumProviderSessionMode: 'stateless',
    glasshive_options: { workspace: workspace ? { ...workspace } : { mode: 'life' }, access: 'read_only' } };
}
/* === VIVENTIUM END === */
