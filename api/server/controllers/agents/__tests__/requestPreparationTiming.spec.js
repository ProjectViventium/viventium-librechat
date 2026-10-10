const fs = require('fs');
const path = require('path');
const vm = require('vm');

const controller = fs.readFileSync(path.resolve(__dirname, '../request.js'), 'utf8');
const start = controller.indexOf('        const onStart = (userMsg, respMsgId, _isNewConvo) => {');
const end = controller.indexOf('        const startPartialCheckpointing = () => {', start);
if (start < 0 || end <= start) throw new Error('Controller start callback unavailable');
const startCallback = controller.slice(start, end);

function preparation({ enabled = true, rejectSource = false, throwLogger = false } = {}) {
  const events = [];
  const lines = [];
  let release;
  const originalError = new Error('Synthetic private persistence failure');
  const source = new Promise((resolve, reject) => {
    release = () => (rejectSource ? reject(originalError) : resolve());
  });
  let registered;
  const context = {
    Date,
    voiceLatencyEnabled: enabled,
    voiceLatencyNow: () => 100,
    trackAssistantSnapshot: (work) => {
      registered = work();
      return registered;
    },
    ensureUserSourceSegmentPersisted: () => source,
    assistantTerminalPersistenceStarted: false,
    persistAssistantSnapshot: async () => {
      events.push('placeholder');
      return { persisted: true, fingerprint: 'synthetic-fingerprint' };
    },
    req: { config: { endpoints: { agents: { providerCapabilities: {} } } } },
    streamId: 'synthetic-stream',
    userId: 'synthetic-owner',
    client: { options: { agent: { endpoint: 'synthetic' } } },
    conversationId: 'synthetic-conversation',
    sender: 'AI',
    GenerationJobManager: {
      updateMetadata: async () => events.push('metadata'),
      emitChunk: async () => events.push('created'),
    },
    logger: { warn: jest.fn() },
    logVoiceLatencyStage: (_req, stage, startedAt, status) => {
      lines.push({ stage, startedAt, status });
      if (throwLogger) throw new Error('Synthetic private logger failure');
    },
  };
  vm.runInNewContext(
    `let userMessage,responseMessageId,generationStartedAt,placeholderSnapshotSaved,lastAssistantSnapshotFingerprint;\n${startCallback}\nglobalThis.onStartForTest = onStart;`,
    context,
  );
  const result = context.onStartForTest(
    { messageId: 'synthetic-user', text: 'Synthetic private message' },
    'synthetic-response',
    false,
  );
  return { events, lines, release, result, originalError, registered };
}

describe('awaited start preparation timing', () => {
  it('records completion only after source and placeholder work completes', async () => {
    const control = preparation();
    expect(control.lines).toEqual([]);
    expect(control.events).toEqual([]);
    control.release();
    await control.result;
    expect(control.events).toEqual(['placeholder', 'metadata', 'created']);
    expect(control.lines).toEqual([
      { stage: 'message_on_start_persistence', startedAt: 100, status: 'status=completed' },
    ]);
    expect(JSON.stringify(control.lines)).not.toContain('Synthetic private');
  });

  it('records failure and preserves the exact persistence error', async () => {
    const control = preparation({ rejectSource: true });
    control.release();
    await expect(control.result).rejects.toBe(control.originalError);
    expect(control.events).toEqual([]);
    expect(control.lines[0].status).toBe('status=failed');
    expect(JSON.stringify(control.lines)).not.toContain(control.originalError.message);
  });

  it('preserves the registered promise and emits nothing when disabled', async () => {
    const control = preparation({ enabled: false });
    expect(control.result).toBe(control.registered);
    control.release();
    await control.result;
    expect(control.events).toEqual(['placeholder', 'metadata', 'created']);
    expect(control.lines).toEqual([]);
  });

  test.each([false, true])(
    'logger failure preserves persistence outcome (rejected=%s)',
    async (rejectSource) => {
      const control = preparation({ throwLogger: true, rejectSource });
      control.release();
      if (rejectSource) await expect(control.result).rejects.toBe(control.originalError);
      else await expect(control.result).resolves.toBeUndefined();
      expect(control.lines).toHaveLength(1);
    },
  );
});
