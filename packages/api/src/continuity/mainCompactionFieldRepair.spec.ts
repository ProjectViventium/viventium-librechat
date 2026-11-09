import {
  applyMainCompactionFieldRepair,
  createMainCompactionOutputContract,
  inspectMainCompactionCandidate,
  mainCompactionFieldRepairContract,
  mainCompactionFieldRepairInput,
} from './mainContinuity';

describe('exact-draft compaction field repair', () => {
  const draft = {
    version: 1 as const,
    summary: 'Repeated context. '.repeat(300),
    pendingAsks: ['Prepare the review. Do not publish it.'],
    commitments: [],
    corrections: [],
    decisions: [],
    recurrenceOutcomes: [],
    toolPairs: [
      { callId: 'call-opaque-17', toolName: 'read_note', outcome: 'Draft saved; review pending.' },
    ],
    durableIdentifiers: ['https://example.invalid/review?id=opaque-17#draft'],
  };
  const contract = createMainCompactionOutputContract({
    consumer: 'accepted_core',
    carrierMaxUtf8Bytes: 131072,
    reservedUtf8Bytes: 128000,
  })!;
  const rejected = inspectMainCompactionCandidate(draft, contract);
  if (rejected.ok) throw new Error('Expected size rejection');
  const repair = mainCompactionFieldRepairContract(draft, rejected.issue, contract)!;
  const patch = {
    version: 1,
    candidateDigest: repair.candidateDigest,
    replacements: { summary: 'Review pending. Publication is not authorized.' },
  };

  test('shortens only selected fields and still requires whole-object validation', () => {
    const merged = applyMainCompactionFieldRepair(patch, draft, repair);
    expect(merged).toEqual({ ...draft, summary: patch.replacements.summary });
    expect(inspectMainCompactionCandidate(merged, contract).ok).toBe(true);
    expect(draft.summary.length).toBeGreaterThan(5000);
    expect(repair.maxSummaryJsonUtf8Bytes).toBe(
      contract.maxJsonUtf8Bytes -
        (Buffer.byteLength(JSON.stringify(draft)) -
          Buffer.byteLength(JSON.stringify(draft.summary))),
    );
    expect(applyMainCompactionFieldRepair(patch, JSON.stringify(draft), repair)).toEqual(merged);
    expect(
      mainCompactionFieldRepairContract(JSON.stringify(draft), rejected.issue, contract),
    ).toEqual(repair);
  });
  test('the same draft-bound repair can restore a fidelity defect without changing schema', () => {
    expect(
      mainCompactionFieldRepairContract(draft, { code: 'semantic_fidelity' }, contract),
    ).toEqual(repair);
    expect(mainCompactionFieldRepairContract(draft, { code: 'unrecognized' }, contract)).toBeNull();
  });
  test('initial reconciliation projects semantic values and never copies server provenance', () => {
    const previous = { ...draft, sourceDigest: 'old-source', generatedAt: new Date(0) };
    const input = mainCompactionFieldRepairInput(previous, '', contract)!;
    expect(input.candidate).toEqual(draft);
    expect(input.contract).toMatchObject({
      baseSource: 'previousSemanticCompaction',
      candidateDigest: repair.candidateDigest,
    });
    const unchanged = applyMainCompactionFieldRepair(
      { version: 1, candidateDigest: input.contract.candidateDigest, replacements: {} },
      input.candidate,
      input.contract,
    );
    expect(unchanged).toBeNull();
    expect(inspectMainCompactionCandidate(unchanged, contract).ok).toBe(false);
    expect(mainCompactionFieldRepairInput(null, '', contract)).toBeNull();
    expect(mainCompactionFieldRepairInput({ version: 1 }, '', contract)).toBeNull();
    expect(mainCompactionFieldRepairInput(previous, { code: 'quality_gate' }, contract)).toBeNull();
  });
  test.each([
    { ...patch, candidateDigest: 'foreign-draft' },
    { ...patch, version: 2 },
    { ...patch, approved: true },
    { ...patch, replacements: {} },
    { ...patch, replacements: { version: 2 } },
    { ...patch, replacements: { unknownField: 'drop history' } },
    { ...patch, replacements: JSON.parse('{"__proto__":{"polluted":true}}') },
  ])('rejects a malformed or unbound repair %#', (output) => {
    expect(applyMainCompactionFieldRepair(output, draft, repair)).toBeNull();
  });
  test('rejects changed bases and unrequested patches; leaves full proposals compatible', () => {
    expect(
      applyMainCompactionFieldRepair(patch, { ...draft, summary: 'changed' }, repair),
    ).toBeNull();
    expect(applyMainCompactionFieldRepair(patch, draft, null)).toBeNull();
    expect(applyMainCompactionFieldRepair(draft, draft, repair)).toBe(draft);
    const oversized = applyMainCompactionFieldRepair(
      { ...patch, replacements: { summary: 'x'.repeat(5000) } },
      draft,
      repair,
    );
    expect(inspectMainCompactionCandidate(oversized, contract).ok).toBe(false);
    expect(mainCompactionFieldRepairContract(draft, { constraint: 'shape' }, contract)).toBeNull();
    expect(mainCompactionFieldRepairContract(draft, rejected.issue, undefined)).toBeNull();
    expect(
      mainCompactionFieldRepairContract(draft, rejected.issue, {
        ...contract,
        maxJsonUtf8Bytes: 0,
      }),
    ).toBeNull();
  });
  test('a selected tool-field replacement still cannot invent a source identity', () => {
    const merged = applyMainCompactionFieldRepair(
      {
        ...patch,
        replacements: {
          ...patch.replacements,
          toolPairs: [{ callId: 'invented-call', toolName: 'publish', outcome: 'Published.' }],
        },
      },
      draft,
      repair,
    );
    const inspected = inspectMainCompactionCandidate(merged, contract, {
      previousSemanticCompaction: draft,
      sourceTurns: [],
    });
    expect(inspected).toMatchObject({ ok: false, issue: { constraint: 'source_identity' } });
  });
});
