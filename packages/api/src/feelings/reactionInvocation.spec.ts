import { createFeelingReactionRequest, feelingReactionNativeOptions } from './reactionInvocation';
import { setTrustedInteractionContext, getTrustedInteractionContext } from '../agents/interactionContext';

describe('isolated reaction transport', () => {
  it('shadows Main’s immutable snapshot without changing the Main request', () => {
    const request = { body: { conversationId: 'conversation' }, user: { id: 'owner' } };
    const mainSnapshot = Object.freeze({ protocol: 'viventium.main_context.v1' });
    Object.defineProperty(request, '_viventiumMainContextSnapshotV1', {
      value: mainSnapshot, writable: false, configurable: false,
    });
    const isolated = createFeelingReactionRequest(request, 'Typed stimulus');
    expect(isolated._viventiumMainContextSnapshotV1).toBeNull();
    expect((request as any)._viventiumMainContextSnapshotV1).toBe(mainSnapshot);
  });
  it('retains Express methods and trusted provenance while removing Voice, tools and self-injection', () => {
    const request = { get: () => 'synthetic', body: { voiceMode: true, viventiumCallSessionId: 'call',
      conversationId: 'conversation', files: ['file'] }, user: { id: 'owner', personalization: {
        memories: true, conversation_recall: true } }, _viventiumFeelingSnapshot: { capsule: 'CANARY' },
      _viventiumGlassHiveWorkerFeelings: 'CAPSULE_CANARY', _viventiumGlassHiveWorkerMemory: 'MEMORY_CANARY',
      _viventiumProviderModelReceipts: new Map([['main', 'receipt']]),
      _viventiumNativeResponseIdentity: { invocation: 'main' },
      _viventiumMainContextSnapshotV1: { content: 'main' }, viventiumVoiceWorkAuthority: { owner: 'main' } };
    setTrustedInteractionContext(request, { actor_kind: 'external_user', origin: 'interactive', surface: 'voice',
      conversation_id: 'conversation', logical_turn_id: 'turn', source_event_id: 'source', revision: 1 });
    const isolated = createFeelingReactionRequest(request, 'Typed stimulus');
    expect(isolated.get()).toBe('synthetic');
    expect(getTrustedInteractionContext(isolated)).toEqual(getTrustedInteractionContext(request));
    expect(isolated.body).toEqual({ conversationId: 'conversation', files: [], text: 'Typed stimulus' });
    expect(isolated.user.personalization).toMatchObject({ memories: false, conversation_recall: false });
    expect(isolated._viventiumFeelingSnapshot).toBeNull();
    expect(isolated._viventiumGlassHiveWorkerFeelings).toBe('');
    expect(isolated._viventiumGlassHiveWorkerMemory).toBe('');
    expect(isolated._viventiumNativeResponseIdentity).toBeNull();
    expect(isolated._viventiumMainContextSnapshotV1).toBeNull();
    expect(isolated.viventiumVoiceWorkAuthority).toBeNull();
    expect(isolated._viventiumProviderModelReceipts.size).toBe(0);
    expect(isolated._viventiumProviderModelReceipts).not.toBe(request._viventiumProviderModelReceipts);
    expect(request._viventiumFeelingSnapshot.capsule).toBe('CANARY');
    expect(feelingReactionNativeOptions('glasshive-harness')).toEqual({
      viventiumProviderSessionMode: 'stateless', glasshive_options: { workspace: { mode:'life' }, access:'read_only' } });
    expect(feelingReactionNativeOptions('openai')).toEqual({});
  });
});
