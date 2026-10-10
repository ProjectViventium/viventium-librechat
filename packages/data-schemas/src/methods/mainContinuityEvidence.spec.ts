/* === VIVENTIUM START === Exact background source remains distinct from receipt and authority. === */
import { createHash } from 'node:crypto';
import {
  mainContinuityMessageEvidence,
  normalizeMainBackgroundInputs,
} from './mainContinuityEvidence';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const text = '### Synthetic cortex\nExact inspection: matériau sûr. 次の事実。\n';
const input = {
  version: 1,
  invocationId: 'invocation',
  deliveryId: 'd'.repeat(64),
  text,
  textSha256: sha(text),
  sources: [
    { cortexId: 'cortex', cortexName: 'Synthetic cortex', insightSha256: sha('Exact inspection') },
  ],
};

test('preserves exact UTF-8 background text and provenance without inventing authored or tool text', () => {
  const message = {
    isCreatedByUser: false,
    text: 'Saved answer.',
    metadata: {
      viventium: {
        backgroundInputs: [input],
        backgroundInputReceipts: [{ status: 'queued', consumed: true }],
      },
    },
  };
  expect(mainContinuityMessageEvidence(message)).toEqual({
    text: 'Saved answer.',
    toolPairs: [],
    backgroundInputs: [input],
  });
  expect(normalizeMainBackgroundInputs([input, input])).toEqual([input]);
  expect(
    mainContinuityMessageEvidence({
      ...message,
      metadata: {
        viventium: {
          ...message.metadata.viventium,
          backgroundInputReceipts: [{ status: 'unavailable' }],
        },
      },
    }),
  ).toEqual(mainContinuityMessageEvidence(message));
  expect(normalizeMainBackgroundInputs(undefined)).toEqual([]);
});

test.each([
  null,
  input,
  [{ ...input, version: 2 }],
  [{ ...input, text: text.trim() }],
  [{ ...input, textSha256: 'x'.repeat(64) }],
  [{ ...input, invocationId: '' }],
  [{ ...input, deliveryId: 'invalid' }],
  [{ ...input, sources: [] }],
  [{ ...input, sources: [{ cortexId: '', insightSha256: sha('evidence') }] }],
  [{ ...input, text: '次'.repeat(22000), textSha256: sha('次'.repeat(22000)) }],
  [input, { ...input, text: 'Changed', textSha256: sha('Changed') }],
])('rejects malformed, changed, oversized or conflicting source without clipping: %j', (value) => {
  expect(() => normalizeMainBackgroundInputs(value)).toThrow(
    'Accepted Main background input is invalid',
  );
});

test('a user row cannot claim a background source', () => {
  expect(() =>
    mainContinuityMessageEvidence({
      isCreatedByUser: true,
      metadata: { viventium: { backgroundInputs: [input] } },
    }),
  ).toThrow();
});
/* === VIVENTIUM END === */
