import { createHash } from 'node:crypto';
import { nativeResponseDigest } from '@librechat/data-schemas';
import {
  nativeToolEvidenceForMemory,
  projectNativeToolEvidence,
  nativeGraphToolEvidenceContent,
} from './nativeToolEvidence';

const bounded = (text: string) => ({
  text,
  bytes: Buffer.byteLength(text),
  sha256: createHash('sha256').update(text).digest('hex'),
  omitted_bytes: 0,
});
const candidate = { runId: 'run', requestId: 'request' };
const identity = {
  userId: 'owner',
  conversationId: 'conversation',
  responseMessageId: 'answer',
  invocationId: 'invocation',
  logicalTurnId: 'turn',
  revision: 2,
};
const envelope = () => ({
  version: 1,
  owner_id: 'owner',
  conversation_id: 'conversation',
  message_id: 'answer',
  invocation_id: 'invocation',
  request_id: 'request',
  run_id: 'run',
  omitted_results: 0,
  excluded_log_prefix_bytes: 0,
  results: [
    {
      id: 'call',
      name: 'authorized-broker/transcribe_audio',
      status: 'completed',
      arguments: bounded('{"file_id":"owned-file"}'),
      output: bounded('Read the contributor guide. Keep files unchanged.'),
    },
  ],
});
const response = (tool_evidence = envelope()) => ({
  id: 'request',
  glasshive: { request_id: 'request', tool_evidence },
});
const message = () => ({
  text: 'The review is ready.',
  content: [],
  metadata: {
    viventium: {
      interactionContext: { logical_turn_id: 'turn', revision: 2 },
      other: 'preserved',
    },
  },
});
const admission = (evidence = envelope()) => {
  const saved = {
    ...candidate,
    text: 'The review is ready.',
    authoritySha256: 'a'.repeat(64),
    responseJson: JSON.stringify(response(evidence)),
  };
  return {
    ...identity,
    status: 'completed' as const,
    candidateJson: JSON.stringify(saved),
    candidateSha256: nativeResponseDigest(saved),
  };
};
const savedMessage = (evidence = envelope()) => ({
  ...projectNativeToolEvidence(identity, response(evidence), message(), candidate),
  user: 'owner',
  messageId: 'answer',
  conversationId: 'conversation',
});

test('canonical native output is retained only through the exact committed candidate', () => {
  const projected = savedMessage();
  expect(projected.metadata?.viventium?.other).toBe('preserved');
  const content = nativeToolEvidenceForMemory(projected, admission());
  expect(content).toHaveLength(2);
  expect(JSON.stringify(content)).toContain('Read the contributor guide. Keep files unchanged.');
  expect(JSON.stringify(content)).toContain('authorized-broker/transcribe_audio');
});

test.each(['owner_id', 'conversation_id', 'message_id', 'invocation_id', 'request_id', 'run_id'])(
  'rejects foreign %s',
  (field) => {
    const evidence = { ...envelope(), [field]: 'foreign' };
    expect(() =>
      projectNativeToolEvidence(identity, response(evidence), message(), candidate),
    ).toThrow('native_tool_evidence_identity_mismatch');
  },
);

test('rejects modified complete output and duplicate native calls', () => {
  const evidence = envelope();
  evidence.results[0].output.text = 'Different output';
  expect(() => savedMessage(evidence)).toThrow('native_tool_evidence_invalid');
  const duplicate = envelope();
  duplicate.results.push(duplicate.results[0]);
  expect(() => savedMessage(duplicate)).toThrow('native_tool_evidence_invalid');
});

test('source revision and owner are checked again before writer formatting', () => {
  const projected = savedMessage();
  expect(() =>
    nativeToolEvidenceForMemory({ ...projected, user: 'foreign' }, admission()),
  ).toThrow();
  const metadata = projected.metadata as ReturnType<typeof message>['metadata'];
  metadata.viventium.interactionContext.revision = 3;
  expect(() => nativeToolEvidenceForMemory(projected, admission())).toThrow();
});

test('failure and omission metadata remain evidence rather than a success claim', () => {
  const evidence = envelope();
  evidence.results[0].status = 'failed';
  evidence.results[0].output.bytes += 100;
  evidence.results[0].output.omitted_bytes = 100;
  evidence.omitted_results = 2;
  evidence.excluded_log_prefix_bytes = 4000;
  const content = nativeToolEvidenceForMemory(savedMessage(evidence), admission(evidence));
  expect(JSON.stringify(content)).toContain('failed');
  expect(JSON.stringify(content)).toContain('omitted_results');
  expect(JSON.stringify(content)).toContain('4000');
});

test('a response without native evidence cannot inherit an earlier or body-authored envelope', () => {
  expect(
    projectNativeToolEvidence(identity, { id: 'request' }, savedMessage()).metadata?.viventium
      ?.nativeToolEvidence,
  ).toBeUndefined();
});

test('omitted-only evidence exposes coverage without inventing a tool result', () => {
  const evidence = envelope();
  evidence.results = [];
  evidence.omitted_results = 3;
  const content = nativeToolEvidenceForMemory(savedMessage(evidence), admission(evidence));
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  expect(JSON.stringify(content)).toContain('omitted_results');
});

test('body-authored or changed metadata cannot author canonical native evidence', () => {
  const input = savedMessage();
  expect(() => nativeToolEvidenceForMemory(input)).toThrow('admission_missing');
  const changed = envelope();
  changed.results[0].output = bounded('A fabricated result');
  expect(() => nativeToolEvidenceForMemory(savedMessage(changed), admission())).toThrow(
    'candidate_mismatch',
  );
  expect(() =>
    nativeToolEvidenceForMemory(input, { ...admission(), candidateSha256: 'wrong' }),
  ).toThrow('candidate_mismatch');
  expect(() => nativeToolEvidenceForMemory(input, { ...admission(), status: 'cancelled' })).toThrow(
    'admission_missing',
  );
});

const graphIdentity = {
  ...identity,
  streamId: 'stream',
  jobCreatedAt: 1,
  bodySha256: 'b'.repeat(64),
  providerId: 'native',
  agentId: 'main',
  originSha256: 'c'.repeat(64),
  source: { id: 'source', messageId: 'question', digest: 'd'.repeat(64) },
  admittedAt: 1,
  recoverUntil: 2,
};
const graph = () => ({
  version: 1,
  owner_id: 'owner',
  conversation_id: 'conversation',
  message_id: 'answer',
  stream_id: 'stream',
  anchor_invocation_id: 'invocation',
  main_context_snapshot_sha256: 'a'.repeat(64),
  context_epoch: 'b'.repeat(64),
  logical_turn_id: 'turn',
  logical_turn_revision: 2,
  omitted_requests: 0,
  requests: ['before', 'after'].map((run) => ({
    request_id: `request-${run}`,
    run_id: run,
    agent_id: 'agent',
    state: 'completed',
    instruction_sha256: 'c'.repeat(64),
    authority_sha256: 'd'.repeat(64),
    evidence_available: true,
    results: envelope().results,
    omitted_results: 0,
    excluded_log_prefix_bytes: 0,
  })),
});

test('separate graph data preserves every node and per-run call identity', () => {
  const content = nativeGraphToolEvidenceContent(graphIdentity, graph());
  const data = JSON.parse(content[0].text).native_tool_evidence;
  expect(data.requests.map((request: { run_id: string }) => request.run_id)).toEqual([
    'before',
    'after',
  ]);
  expect(data.requests[1].results[0].output.text).toContain('contributor guide');
});

test.each([
  'owner_id',
  'conversation_id',
  'message_id',
  'stream_id',
  'anchor_invocation_id',
  'logical_turn_id',
])('graph data rejects mismatched %s', (key) => {
  expect(() =>
    nativeGraphToolEvidenceContent(graphIdentity, { ...graph(), [key]: 'foreign' }),
  ).toThrow('identity_mismatch');
});

test('graph data rejects a stale revision, modified record and duplicate run', () => {
  expect(() =>
    nativeGraphToolEvidenceContent(graphIdentity, { ...graph(), logical_turn_revision: 3 }),
  ).toThrow();
  const changed = graph();
  changed.requests[0].results[0].output.text = 'fabricated';
  expect(() => nativeGraphToolEvidenceContent(graphIdentity, changed)).toThrow('invalid');
  const duplicate = graph();
  duplicate.requests.push(duplicate.requests[0]);
  expect(() => nativeGraphToolEvidenceContent(graphIdentity, duplicate)).toThrow('invalid');
});
