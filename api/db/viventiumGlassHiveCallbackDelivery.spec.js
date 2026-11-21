/* === VIVENTIUM START === Strict native file metadata survives the durable callback carrier. === */
const mongoose = require('mongoose');
const createModel = require('./viventiumGlassHiveCallbackDelivery');
const Model = createModel(new mongoose.Mongoose());

function delivery(nativeOutputFile) {
  return new Model({
    deliveryKey: 'synthetic-delivery',
    deliveryId: 'synthetic-delivery',
    callbackMessageId: 'synthetic-response',
    userId: 'synthetic-owner',
    conversationId: 'synthetic-conversation',
    surface: 'telegram',
    event: 'main.followup',
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    attachments: [{ filename: 'result.md', object: 'file', nativeOutputFile }],
  });
}

const available = {
  version: 1,
  status: 'available',
  messageId: 'synthetic-response',
  downloadUrl: 'https://files.example.test/v1/link-refs/synthetic-grant',
};

test('retains the available native grant exactly in the strict delivery schema', () => {
  const doc = delivery(available);
  expect(doc.validateSync()).toBeUndefined();
  expect(doc.toObject().attachments[0].nativeOutputFile).toEqual(available);
});

test('retains the unavailable native file receipt', () => {
  const receipt = { version: 1, status: 'unavailable', code: 'native_output_file_digest_mismatch' };
  const doc = delivery(receipt);
  expect(doc.validateSync()).toBeUndefined();
  expect(doc.toObject().attachments[0].nativeOutputFile).toEqual(receipt);
});

test.each(['messageId', 'downloadUrl'])('available carrier requires %s', (field) => {
  const receipt = { ...available };
  delete receipt[field];
  expect(delivery(receipt).validateSync()).toBeDefined();
});

test('unavailable carrier still requires its failure code', () => {
  expect(delivery({ version: 1, status: 'unavailable' }).validateSync()).toBeDefined();
});

test.each([
  { ...available, version: 2 },
  { ...available, status: 'unknown' },
  { ...available, forgedAuthority: 'synthetic-extra-field' },
])('rejects invalid version, state or undeclared fields: %p', (receipt) => {
  expect(delivery(receipt).validateSync()).toBeDefined();
});
/* === VIVENTIUM END === */

test('retains exact immutable Main admission proof without a fabricated worker result', () => {
  const doc = delivery(available);
  doc.mainGenerationPresentation = {
    version: 1,
    streamId: 'scheduled-stream',
    admissionId: 'scheduled-admission',
    responseMessageId: 'synthetic-response',
    responseDigest: 'sha256:' + 'a'.repeat(64),
  };
  expect(doc.validateSync()).toBeUndefined();
  expect(doc.toObject().mainGenerationPresentation).toEqual({
    version: 1,
    streamId: 'scheduled-stream',
    admissionId: 'scheduled-admission',
    responseMessageId: 'synthetic-response',
    responseDigest: 'sha256:' + 'a'.repeat(64),
  });
});

const nativeSource = {
  kind: 'native_coordinator_goal',
  bindingRef: 'native-binding',
  nativeConversationId: 'native-conversation',
  goalId: 'native-goal',
  runId: 'native-run',
  resultRevision: 1,
  resultDigest: 'sha256:' + 'b'.repeat(64),
  sourceTurnId: 'native-source',
  sourceCallSessionId: 'source-call',
};

test('retains strict real Native source v2 without a fabricated schedule admission', async () => {
  const doc = delivery(available);
  doc.mainGenerationPresentation = {
    version: 2,
    nativeCoordinatorResult: nativeSource,
    responseMessageId: 'synthetic-response',
    responseDigest: 'sha256:' + 'a'.repeat(64),
  };
  await expect(doc.validate()).resolves.toBeUndefined();
  expect(doc.toObject().mainGenerationPresentation).toEqual({
    version: 2,
    nativeCoordinatorResult: nativeSource,
    responseMessageId: 'synthetic-response',
    responseDigest: 'sha256:' + 'a'.repeat(64),
  });
});

test('retains Native Telegram source without inventing a call session', async () => {
  const doc = delivery(available);
  doc.mainGenerationPresentation = {
    version: 2,
    nativeCoordinatorResult: { ...nativeSource, sourceCallSessionId: '' },
    responseMessageId: 'synthetic-response',
    responseDigest: 'sha256:' + 'a'.repeat(64),
  };
  await expect(doc.validate()).resolves.toBeUndefined();
  expect(doc.mainGenerationPresentation.nativeCoordinatorResult.sourceCallSessionId).toBe('');
});

test.each([
  { version: 2, admissionId: 'fake-admission' },
  { version: 2, streamId: 'fake-job' },
  { version: 1, streamId: 'stream', admissionId: 'admission' },
])('rejects mixed source variants %p', async (change) => {
  const doc = delivery(available);
  doc.mainGenerationPresentation = {
    version: 2,
    nativeCoordinatorResult: nativeSource,
    responseMessageId: 'synthetic-response',
    responseDigest: 'sha256:' + 'a'.repeat(64),
    ...change,
  };
  await expect(doc.validate()).rejects.toThrow('main_generation_source_variant_invalid');
});

const nativeTurnSource = {
  kind: 'native_coordinator_turn',
  bindingRef: 'native-binding',
  nativeConversationId: 'native-conversation',
  turnId: 'native-turn',
  requestId: 'native-request',
  runId: 'native-run',
  resultRevision: 1,
  resultDigest: 'sha256:' + 'b'.repeat(64),
  sourceTurnId: 'original-source',
  sourceCallSessionId: '',
};

test.each(['telegram', 'voice'])(
  'retains real Native turn Main authority in the %s carrier without a fake goal',
  async (surface) => {
    const doc = delivery(available);
    doc.surface = surface;
    doc.mainGenerationPresentation = {
      version: 2,
      nativeCoordinatorResult: nativeTurnSource,
      responseMessageId: 'synthetic-response',
      responseDigest: 'sha256:' + 'a'.repeat(64),
    };
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.toObject().mainGenerationPresentation.nativeCoordinatorResult).toEqual(
      nativeTurnSource,
    );
    expect(doc.toObject().mainGenerationPresentation.nativeCoordinatorResult).not.toHaveProperty(
      'goalId',
    );
  },
);

test.each(['turnId', 'requestId'])('Native-turn carrier requires exact %s', async (field) => {
  const source = { ...nativeTurnSource };
  delete source[field];
  const doc = delivery(available);
  doc.mainGenerationPresentation = {
    version: 2,
    nativeCoordinatorResult: source,
    responseMessageId: 'synthetic-response',
    responseDigest: 'sha256:' + 'a'.repeat(64),
  };
  await expect(doc.validate()).rejects.toThrow();
});

test.each([
  { ...nativeTurnSource, goalId: 'fake-goal' },
  { ...nativeSource, turnId: 'fake-turn' },
  { ...nativeSource, requestId: 'fake-request' },
])('carrier rejects mixed goal/turn identities', async (source) => {
  const doc = delivery(available);
  doc.mainGenerationPresentation = {
    version: 2,
    nativeCoordinatorResult: source,
    responseMessageId: 'synthetic-response',
    responseDigest: 'sha256:' + 'a'.repeat(64),
  };
  await expect(doc.validate()).rejects.toThrow('native_coordinator_result_source_variant_invalid');
});

test('legacy goal authority JSON stays byte-exact with no new turn field defaults', async () => {
  const expected = {
    version: 2,
    nativeCoordinatorResult: nativeSource,
    responseMessageId: 'synthetic-response',
    responseDigest: 'sha256:' + 'a'.repeat(64),
  };
  const doc = delivery(available);
  doc.mainGenerationPresentation = expected;
  await expect(doc.validate()).resolves.toBeUndefined();
  expect(JSON.stringify(doc.toObject().mainGenerationPresentation)).toBe(JSON.stringify(expected));
  expect(doc.toObject().mainGenerationPresentation.nativeCoordinatorResult).not.toHaveProperty(
    'turnId',
  );
  expect(doc.toObject().mainGenerationPresentation.nativeCoordinatorResult).not.toHaveProperty(
    'requestId',
  );
});

const progressSource = {
  kind: 'native_coordinator_progress',
  bindingRef: 'native-binding',
  nativeConversationId: 'native-conversation',
  goalId: 'goal',
  runId: 'run',
  attemptId: 'attempt',
  progressId: 'c'.repeat(64),
  progressDigest: 'sha256:' + 'd'.repeat(64),
  sourceTurnId: 'source-turn',
  sourceCallSessionId: '',
};

test('progress bridge preserves exact immutable goal or turn source through durable carrier roundtrip', async () => {
  const { goalId: _goalId, ...common } = progressSource;
  for (const source of [progressSource, { ...common, turnId: 'turn', requestId: 'request' }]) {
    const doc = delivery(available);
    const presentation = {
      version: 3,
      nativeCoordinatorProgress: source,
      responseMessageId: 'synthetic-response',
      responseDigest: 'sha256:' + 'a'.repeat(64),
    };
    doc.mainGenerationPresentation = presentation;
    await expect(doc.validate()).resolves.toBeUndefined();
    const loaded = Model.hydrate(JSON.parse(JSON.stringify(doc.toObject())));
    await expect(loaded.validate()).resolves.toBeUndefined();
    expect(loaded.toObject().mainGenerationPresentation).toEqual(presentation);
    expect(loaded.toObject().mainGenerationPresentation).not.toHaveProperty(
      'nativeCoordinatorResult',
    );
    expect(loaded.toObject().mainGenerationPresentation).not.toHaveProperty('streamId');
    loaded.mainGenerationPresentation.nativeCoordinatorProgress.progressDigest =
      'sha256:' + 'e'.repeat(64);
    expect(loaded.mainGenerationPresentation.nativeCoordinatorProgress.progressDigest).toBe(
      source.progressDigest,
    );
  }
});

test('progress bridge carrier rejects incomplete scope, invalid digest and mixed terminal or scheduled variants', async () => {
  const presentation = {
    version: 3,
    nativeCoordinatorProgress: progressSource,
    responseMessageId: 'synthetic-response',
    responseDigest: 'sha256:' + 'a'.repeat(64),
  };
  for (const change of [
    { kind: 'native_coordinator_goal' },
    { attemptId: undefined },
    { sourceTurnId: undefined },
    { progressId: 'bad-id' },
    { progressDigest: 'bad-digest' },
    { turnId: 'mixed-turn' },
    { resultRevision: 1 },
    { outputFiles: [] },
  ]) {
    const doc = delivery(available);
    doc.mainGenerationPresentation = {
      ...presentation,
      nativeCoordinatorProgress: { ...progressSource, ...change },
    };
    await expect(doc.validate()).rejects.toThrow();
  }
  for (const change of [
    { nativeCoordinatorResult: nativeSource },
    { streamId: 'fake-job' },
    { admissionId: 'fake-admission' },
    { version: 2, nativeCoordinatorResult: nativeSource },
    { version: 1, streamId: 'fake-job', admissionId: 'fake-admission' },
  ]) {
    const doc = delivery(available);
    doc.mainGenerationPresentation = { ...presentation, ...change };
    await expect(doc.validate()).rejects.toThrow('main_generation_source_variant_invalid');
  }
});
