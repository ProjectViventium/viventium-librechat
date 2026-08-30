import mongoose from 'mongoose';
import { createViventiumOrchestrationTraceEventModel } from '~/models/orchestrationTraceEvent';

const database = new mongoose.Mongoose();
const TraceEvent = createViventiumOrchestrationTraceEventModel(database);

const hash = (value: string) => `sha256:${value.repeat(64)}`;

describe('ViventiumOrchestrationTraceEvent model', () => {
  test('stores only bounded hashes and strict typed facts', () => {
    for (const forbidden of [
      'ownerId',
      'originRef',
      'workRef',
      'runRef',
      'promptText',
      'chatText',
      'path',
      'url',
      'token',
    ]) {
      expect(TraceEvent.schema.path(forbidden)).toBeUndefined();
    }
    expect(TraceEvent.schema.path('facts').schema.options.strict).toBe('throw');
  });

  test('keeps sequence and event-key uniqueness scoped to redacted owner and origin', () => {
    expect(TraceEvent.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { ownerScopeHash: 1, originRefHash: 1, sequence: 1 },
          expect.objectContaining({ unique: true }),
        ],
        [
          { ownerScopeHash: 1, originRefHash: 1, eventKeyHash: 1 },
          expect.objectContaining({ unique: true }),
        ],
      ]),
    );
  });

  test('accepts one synthetic redacted fact and rejects raw or malformed fields', async () => {
    const valid = {
      schemaVersion: 1,
      ownerScopeHash: hash('a'),
      originRefHash: hash('b'),
      sequence: 1,
      stage: 'source.bound',
      at: new Date('2026-08-30T12:00:00.000Z'),
      facts: { workRefHash: hash('c'), state: 'accepted' },
      eventKeyHash: hash('d'),
      contentHash: hash('e'),
      previousEventHash: hash('f'),
      eventHash: hash('0'),
    };

    await expect(new TraceEvent(valid).validate()).resolves.toBeUndefined();
    await expect(
      new TraceEvent({ ...valid, ownerScopeHash: 'owner-private' }).validate(),
    ).rejects.toThrow();
    await expect(
      new TraceEvent({ ...valid, facts: { ...valid.facts, rawPrompt: 'reject' } }).validate(),
    ).rejects.toThrow();
  });
});
