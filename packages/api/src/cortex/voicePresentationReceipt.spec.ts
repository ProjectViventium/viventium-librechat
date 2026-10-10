import {
  confirmVoiceCortexPresentation,
  prepareVoiceCortexPresentation,
  resolveAcceptedVoiceCortexDispatch,
} from './voicePresentationReceipt';
import type { VoiceCortexMessage, VoiceCortexReceiptInput } from './voicePresentationReceipt';

function fixture() {
  const input: VoiceCortexReceiptInput = {
    ownerId: 'owner',
    conversationId: 'conversation',
    parentMessageId: 'parent',
    callSessionId: 'call',
    taskId: 'task',
    streamId: 'stream',
    turnId: 'turn',
    presentationRef: 'child',
    stage: 'audio.completed',
  };
  const parent: VoiceCortexMessage = {
    user: 'owner',
    conversationId: 'conversation',
    messageId: 'parent',
    text: 'Primary reply.',
    isCreatedByUser: false,
    metadata: {
      viventium: {
        callSessionId: 'call',
        voiceTaskId: 'task',
        interactionContext: {
          surface: 'voice',
          logical_turn_id: 'turn',
        },
      },
    },
  };
  const child: VoiceCortexMessage = {
    user: 'owner',
    conversationId: 'conversation',
    messageId: 'child',
    text: 'Useful additional result.',
    isCreatedByUser: false,
    metadata: {
      viventium: {
        parentMessageId: 'parent',
        cortexPresentationParentMessageId: 'parent',
        cortexInsightDeliveryIds: ['delivery'],
        cortexPresentationGeneration: 1,
        cortexPresentationClaimToken: 'claim',
        messageRevision: 1,
      },
    },
  };
  const fence = {
    ownerId: 'owner',
    messageId: 'child',
    parentMessageId: 'parent',
    revision: 1,
    generation: 1,
    claimToken: 'claim',
    presentationLeaseToken: 'lease',
    surface: 'voice' as const,
    deliveryIds: ['delivery'],
    deliveryReceipts: [{ deliveryId: 'delivery', graphResultHash: 'a'.repeat(64) }],
    claims: [
      {
        deliveryId: 'delivery',
        graphResultHash: 'a'.repeat(64),
        claimToken: 'claim',
        claimGeneration: 1,
        presentationLeaseToken: 'lease',
        attemptNumber: 1,
      },
    ],
  };
  const deps = {
    listByParent: jest.fn(async () => [
      {
        deliveryId: 'delivery',
        persistedMessageId: child.messageId,
        claimGeneration: child.metadata!.viventium!.cortexPresentationGeneration,
        messageRevision: child.metadata!.viventium!.messageRevision,
        status: 'claimed',
        presentedSurfaces: [] as string[],
      },
    ]),
    readMessage: jest.fn(
      async ({ messageId }: { messageId: string }): Promise<VoiceCortexMessage | null> =>
        messageId === 'child' ? child : parent,
    ),
    recordReceipt: jest.fn<
      Promise<boolean>,
      Parameters<Parameters<typeof confirmVoiceCortexPresentation>[1]['recordReceipt']>
    >(async (message, receipt) => {
      message.metadata!.viventium!.deliveryAcknowledgement = { cortexPresentation: receipt };
      return true;
    }),
    fencePresentationByParent: jest.fn().mockResolvedValue(fence),
    markDropped: jest
      .fn()
      .mockResolvedValue([
        {
          deliveryId: 'delivery',
          claimGeneration: 1,
          status: 'dropped',
          dropReason: 'delivery_outcome_unknown',
          presentedSurfaces: [],
        },
      ]),
    markPresentationByParent: jest.fn().mockResolvedValue([
      {
        deliveryId: 'delivery',
        claimGeneration: 1,
        status: 'sent',
        presentedSurfaces: ['voice'],
      },
    ]),
  };
  return { input, parent, child, fence, deps };
}

test('completed audible child uses its canonical graph fence and persists the receipt before settlement', async () => {
  const { input, child, deps } = fixture();
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps);
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
  const result = await confirmVoiceCortexPresentation(input, deps);
  expect(result).toEqual([
    expect.objectContaining({ status: 'sent', presentedSurfaces: ['voice'] }),
  ]);
  expect(deps.fencePresentationByParent).toHaveBeenCalledWith({
    ownerId: 'owner',
    parentMessageId: 'parent',
    surface: 'voice',
    persistedMessageId: 'child',
    messageRevision: 1,
    expectedDeliveryIds: ['delivery'],
    expectedGeneration: 1,
    leaseMs: 900000,
  });
  expect(deps.recordReceipt.mock.invocationCallOrder[0]).toBeLessThan(
    deps.markPresentationByParent.mock.invocationCallOrder[0],
  );
  expect(deps.markPresentationByParent).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedPresentationLeaseToken: 'lease',
      presentationClaimToken: 'claim',
      expectedDeliveryReceipts: [{ deliveryId: 'delivery', graphResultHash: 'a'.repeat(64) }],
    }),
  );
});

test('duplicate completion and a retry after settlement failure reuse the durable exact fence', async () => {
  const { input, child, deps } = fixture();
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps);
  deps.markPresentationByParent.mockRejectedValueOnce(new Error('durable store unavailable'));
  await expect(confirmVoiceCortexPresentation(input, deps)).rejects.toThrow(
    'durable store unavailable',
  );
  await confirmVoiceCortexPresentation(input, deps);
  await confirmVoiceCortexPresentation(input, deps);
  expect(deps.fencePresentationByParent).toHaveBeenCalledTimes(1);
  expect(deps.recordReceipt).toHaveBeenCalledTimes(1);
  expect(deps.markPresentationByParent).toHaveBeenCalledTimes(3);
  expect(deps.markPresentationByParent.mock.calls[0][0]).toEqual(
    deps.markPresentationByParent.mock.calls[2][0],
  );
});

test.each([
  'tts.completed',
  'audio.failed',
  'audio.superseded',
  'audio.started',
  'audio.cancelled',
])('%s cannot settle a Cortex delivery', async (stage) => {
  const { input, deps } = fixture();
  expect(await confirmVoiceCortexPresentation({ ...input, stage }, deps)).toBeNull();
  expect(deps.readMessage).not.toHaveBeenCalled();
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
});

test('ordinary parent speech remains trace-only and missing child presentation is not invented', async () => {
  const { input, deps } = fixture();
  expect(
    await confirmVoiceCortexPresentation({ ...input, presentationRef: 'parent' }, deps),
  ).toBeNull();
  deps.readMessage.mockResolvedValueOnce(null);
  expect(await confirmVoiceCortexPresentation(input, deps)).toBeNull();
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
});

test.each([
  'ownerId',
  'conversationId',
  'parentMessageId',
  'callSessionId',
  'taskId',
  'turnId',
] as const)('rejects a completion for the wrong %s', async (field) => {
  const { input, deps } = fixture();
  await expect(
    confirmVoiceCortexPresentation({ ...input, [field]: 'wrong' }, deps),
  ).rejects.toMatchObject({
    code: 'cortex_voice_presentation_receipt_conflict',
  });
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
});

test.each(['user', 'conversationId', 'messageId'] as const)(
  'rejects an incorrectly resolved child %s',
  async (field) => {
    const { input, child, deps } = fixture();
    child[field] = 'wrong';
    await expect(confirmVoiceCortexPresentation(input, deps)).rejects.toMatchObject({
      code: 'cortex_voice_presentation_receipt_conflict',
    });
    expect(deps.markPresentationByParent).not.toHaveBeenCalled();
  },
);

test.each(['error', 'unfinished', 'isCreatedByUser'] as const)(
  'rejects child %s',
  async (field) => {
    const { input, child, deps } = fixture();
    child[field] = true;
    await expect(confirmVoiceCortexPresentation(input, deps)).rejects.toMatchObject({
      code: 'cortex_voice_presentation_receipt_conflict',
    });
    expect(deps.markPresentationByParent).not.toHaveBeenCalled();
  },
);

test.each(['revision', 'generation', 'claimToken', 'messageId', 'parentMessageId'] as const)(
  'rejects a stale canonical fence %s before storing an acknowledgement',
  async (field) => {
    const { input, child, fence, deps } = fixture();
    Object.assign(fence, { [field]: typeof fence[field] === 'number' ? 2 : 'wrong' });
    await expect(
      prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps),
    ).rejects.toMatchObject({
      code: 'cortex_voice_presentation_receipt_conflict',
    });
    expect(deps.recordReceipt).not.toHaveBeenCalled();
    expect(deps.markPresentationByParent).not.toHaveBeenCalled();
  },
);

test.each([
  'text',
  'messageRevision',
  'cortexPresentationGeneration',
  'cortexPresentationClaimToken',
] as const)('rejects a durable completion replay after current child %s changes', async (field) => {
  const { input, child, deps } = fixture();
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps);
  await confirmVoiceCortexPresentation(input, deps);
  deps.markPresentationByParent.mockClear();
  if (field === 'text') child.text = 'Changed saved response.';
  else
    Object.assign(child.metadata!.viventium!, { [field]: field.includes('Token') ? 'wrong' : 2 });
  await expect(confirmVoiceCortexPresentation(input, deps)).rejects.toMatchObject({
    code: 'cortex_voice_presentation_receipt_conflict',
  });
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
});

test('an unmatched durable acknowledgement and incomplete settlement are rejected', async () => {
  const { input, child, deps } = fixture();
  deps.recordReceipt.mockResolvedValueOnce(false);
  await expect(
    prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps),
  ).rejects.toMatchObject({
    code: 'cortex_voice_presentation_receipt_conflict',
  });
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps);
  deps.markPresentationByParent.mockResolvedValueOnce([]);
  await expect(confirmVoiceCortexPresentation(input, deps)).rejects.toMatchObject({
    code: 'cortex_insight_delivery_settlement_conflict',
  });
});

test('completion without a sealed before-playback source cannot acknowledge current edited text', async () => {
  const { input, child, deps } = fixture();
  await expect(confirmVoiceCortexPresentation(input, deps)).rejects.toMatchObject({
    code: 'cortex_voice_presentation_receipt_conflict',
  });
  await expect(
    prepareVoiceCortexPresentation(
      { ...input, text: 'Different fetched text.', leaseMs: 900000 },
      deps,
    ),
  ).rejects.toMatchObject({ code: 'cortex_voice_presentation_receipt_conflict' });
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps);
  child.text = 'Edited after playback started.';
  await expect(confirmVoiceCortexPresentation(input, deps)).rejects.toMatchObject({
    code: 'cortex_voice_presentation_receipt_conflict',
  });
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
});

test('already presented Voice text is not returned for fresh playback while completion remains retryable', async () => {
  const { input, child, deps } = fixture();
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps);
  await confirmVoiceCortexPresentation(input, deps);
  deps.listByParent.mockResolvedValueOnce([
    {
      deliveryId: 'delivery',
      persistedMessageId: child.messageId,
      claimGeneration: 1,
      messageRevision: 1,
      status: 'sent',
      presentedSurfaces: ['voice'],
    },
  ]);
  expect(
    await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps),
  ).toBe(false);
  await confirmVoiceCortexPresentation(input, deps);
  expect(deps.fencePresentationByParent).toHaveBeenCalledTimes(1);
});

test('a new canonical generation must replace old receipt metadata before recovery can play', async () => {
  const { input, child, fence, deps } = fixture();
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps);
  child.metadata!.viventium!.cortexPresentationGeneration = 2;
  child.metadata!.viventium!.cortexPresentationClaimToken = 'new-claim';
  await expect(
    prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps),
  ).rejects.toMatchObject({ code: 'cortex_voice_presentation_receipt_conflict' });
  delete child.metadata!.viventium!.deliveryAcknowledgement;
  fence.generation = 2;
  fence.claimToken = 'new-claim';
  fence.presentationLeaseToken = 'new-lease';
  deps.markPresentationByParent.mockResolvedValueOnce([
    { deliveryId: 'delivery', claimGeneration: 2, status: 'sent', presentedSurfaces: ['voice'] },
  ]);
  expect(
    await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps),
  ).toBe(true);
  await confirmVoiceCortexPresentation(input, deps);
  expect(deps.markPresentationByParent).toHaveBeenCalledWith(
    expect.objectContaining({
      presentationGeneration: 2,
      presentationClaimToken: 'new-claim',
      expectedPresentationLeaseToken: 'new-lease',
    }),
  );
});

/* === VIVENTIUM START === Interruption consumes only the canonical issued Cortex claim. === */
test('interrupted child drops exact claims without marking a surface presented or losing its result', async () => {
  const { input, child, deps } = fixture();
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps);
  expect(
    await confirmVoiceCortexPresentation({ ...input, stage: 'audio.interrupted' }, deps),
  ).toEqual([
    expect.objectContaining({ status: 'dropped', dropReason: 'delivery_outcome_unknown' }),
  ]);
  expect(deps.markDropped).toHaveBeenCalledWith({
    ownerId: input.ownerId,
    claims: [{ deliveryId: 'delivery', claimToken: 'claim', claimGeneration: 1 }],
    dropReason: 'delivery_outcome_unknown',
    allowExpiredLease: true,
    presentation: {
      surface: 'voice',
      parentMessageId: input.parentMessageId,
      persistedMessageId: child.messageId,
      messageRevision: 1,
      presentationClaimToken: 'claim',
      claimGeneration: 1,
      presentationRef: input.presentationRef,
      presentationLeaseToken: 'lease',
      deliveryReceipts: [{ deliveryId: 'delivery', graphResultHash: 'a'.repeat(64) }],
    },
  });
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
  expect(child.text).toBe('Useful additional result.');
});

test.each([
  'ownerId',
  'conversationId',
  'parentMessageId',
  'callSessionId',
  'taskId',
  'streamId',
  'turnId',
  'presentationRef',
] as const)('interruption with foreign %s cannot consume a claim', async (field) => {
  const { input, child, deps } = fixture();
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps);
  if (field === 'presentationRef') deps.readMessage.mockResolvedValueOnce(null);
  const attempt = confirmVoiceCortexPresentation(
    { ...input, stage: 'audio.interrupted', [field]: 'foreign' },
    deps,
  );
  if (field === 'presentationRef') expect(await attempt).toBeNull();
  else
    await expect(attempt).rejects.toMatchObject({
      code: 'cortex_voice_presentation_receipt_conflict',
    });
  expect(deps.markDropped).not.toHaveBeenCalled();
});

test.each(['new-generation', 'new-revision', 'already-sent', 'unrelated-drop'])(
  '%s is not consumed by an old interruption',
  async (fault) => {
    const { input, child, deps } = fixture();
    await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps);
    deps.listByParent.mockResolvedValueOnce([
      {
        deliveryId: 'delivery',
        persistedMessageId: child.messageId,
        claimGeneration: fault === 'new-generation' ? 2 : 1,
        messageRevision: fault === 'new-revision' ? 2 : 1,
        status:
          fault === 'already-sent' ? 'sent' : fault === 'unrelated-drop' ? 'dropped' : 'claimed',
        dropReason: fault === 'unrelated-drop' ? 'stale_generation' : '',
        presentedSurfaces: [],
      },
    ]);
    await expect(
      confirmVoiceCortexPresentation({ ...input, stage: 'audio.interrupted' }, deps),
    ).rejects.toMatchObject({ code: 'cortex_voice_presentation_receipt_conflict' });
    expect(deps.markDropped).not.toHaveBeenCalled();
  },
);

test('interrupted drop is idempotent and later Voice fetch cannot re-play it', async () => {
  const { input, child, deps } = fixture();
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps);
  await confirmVoiceCortexPresentation({ ...input, stage: 'audio.interrupted' }, deps);
  deps.listByParent.mockResolvedValue([
    {
      deliveryId: 'delivery',
      persistedMessageId: child.messageId,
      claimGeneration: 1,
      messageRevision: 1,
      status: 'dropped',
      dropReason: 'delivery_outcome_unknown',
      presentedSurfaces: [],
    },
  ]);
  await confirmVoiceCortexPresentation({ ...input, stage: 'audio.interrupted' }, deps);
  expect(
    await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps),
  ).toBe(false);
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === The existing prepare receipt accepts one Voice dispatch, not heard audio. === */
test('accepted handoff is returned only once and does not mark any delivery heard', async () => {
  const { input, child, deps } = fixture();
  const prepared = { ...input, text: child.text, leaseMs: 900000 };
  expect(await prepareVoiceCortexPresentation(prepared, deps)).toBe(true);
  expect(child.metadata?.viventium?.deliveryAcknowledgement?.cortexPresentation).toMatchObject({
    dispatchAccepted: true,
  });
  expect(await prepareVoiceCortexPresentation(prepared, deps)).toBe(false);
  expect(deps.recordReceipt).toHaveBeenCalledTimes(1);
  expect(deps.fencePresentationByParent).toHaveBeenCalledTimes(1);
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
  expect(deps.markDropped).not.toHaveBeenCalled();
});

test('a failed prepare receipt CAS cannot authorize a handoff', async () => {
  const { input, child, deps } = fixture();
  deps.recordReceipt.mockResolvedValueOnce(false);
  await expect(
    prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 900000 }, deps),
  ).rejects.toMatchObject({ code: 'cortex_voice_presentation_receipt_conflict' });
  expect(child.metadata?.viventium?.deliveryAcknowledgement?.cortexPresentation).toBeUndefined();
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
  expect(deps.markDropped).not.toHaveBeenCalled();
});

test('a legacy unaccepted receipt is resealed by the existing CAS before its single handoff', async () => {
  const { input, child, deps } = fixture();
  const prepared = { ...input, text: child.text, leaseMs: 900000 };
  await prepareVoiceCortexPresentation(prepared, deps);
  Reflect.deleteProperty(
    child.metadata!.viventium!.deliveryAcknowledgement!.cortexPresentation!,
    'dispatchAccepted',
  );
  expect(await prepareVoiceCortexPresentation(prepared, deps)).toBe(true);
  expect(child.metadata?.viventium?.deliveryAcknowledgement?.cortexPresentation).toMatchObject({
    dispatchAccepted: true,
  });
  expect(await prepareVoiceCortexPresentation(prepared, deps)).toBe(false);
  expect(deps.recordReceipt).toHaveBeenCalledTimes(2);
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Canonical accepted-dispatch checks remain in the typed owner. === */
test('the typed accepted-dispatch reader preserves the exact private fence without another write', async () => {
  const { input, child, fence, deps } = fixture();
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 30000 }, deps);
  const result = resolveAcceptedVoiceCortexDispatch(child, input);
  expect(result).toEqual({
    surface: 'voice',
    parentMessageId: 'parent',
    persistedMessageId: 'child',
    messageRevision: 1,
    presentationClaimToken: 'claim',
    claimGeneration: 1,
    presentationRef: 'child',
    presentationLeaseToken: 'lease',
    deliveryReceipts: fence.deliveryReceipts,
  });
  expect(deps.recordReceipt).toHaveBeenCalledTimes(1);
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
});

test('the typed reader leaves missing or unaccepted messages recoverable', () => {
  const { input, child } = fixture();
  expect(resolveAcceptedVoiceCortexDispatch(null, input)).toBeNull();
  expect(resolveAcceptedVoiceCortexDispatch(child, input)).toBeNull();
});

test.each([
  'owner',
  'parent',
  'message',
  'revision',
  'generation',
  'claim',
  'ids',
  'hash',
] as const)('the typed reader rejects an accepted receipt with changed %s', async (field) => {
  const { input, child, deps } = fixture();
  await prepareVoiceCortexPresentation({ ...input, text: child.text, leaseMs: 30000 }, deps);
  const meta = child.metadata!.viventium!;
  const receipt = meta.deliveryAcknowledgement!.cortexPresentation!;
  if (field === 'owner') receipt.ownerId = 'foreign';
  if (field === 'parent') receipt.parentMessageId = 'other-parent';
  if (field === 'message') receipt.messageId = 'other-child';
  if (field === 'revision') receipt.revision = 2;
  if (field === 'generation') receipt.generation = 2;
  if (field === 'claim') receipt.claimToken = 'other-claim';
  if (field === 'ids') receipt.deliveryIds = ['other-delivery'];
  if (field === 'hash') child.text = 'Changed result.';
  expect(() => resolveAcceptedVoiceCortexDispatch(child, input)).toThrow(
    'Canonical accepted Cortex Voice receipt did not match',
  );
  expect(deps.markPresentationByParent).not.toHaveBeenCalled();
});
/* === VIVENTIUM END === */
