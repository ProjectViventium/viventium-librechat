import {
  confirmVoiceCortexPresentation,
  prepareVoiceCortexPresentation,
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
  'audio.interrupted',
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
