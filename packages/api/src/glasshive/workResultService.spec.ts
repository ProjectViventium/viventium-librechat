import { createGlassHiveWorkResultService } from './workResultService';

describe('retained work result read', () => {
  const missionEvidence = { findOne: jest.fn(), updateOne: jest.fn(), insertOne: jest.fn() };
  const externalWork = { findOne: jest.fn(), updateOne: jest.fn() };
  const service = createGlassHiveWorkResultService(missionEvidence, externalWork);
  const original = 'Read all accepted sources.\nPreserve exact constraints and output structure.';
  const row = {
    ownerId: 'owner-a',
    runId: 'run-a',
    workRef: 'work-a',
    workState: 'completed',
    state: 'completed',
    evidence: 'complete evidence '.repeat(1500),
    runInput: { version: 1, run_id: 'run-a', instruction: original },
    terminalCallbackResultRevision: 3,
    secret: 'must not escape',
  };
  beforeEach(() => {
    jest.clearAllMocks();
    missionEvidence.findOne.mockResolvedValue(row);
  });
  afterEach(() => {
    expect(missionEvidence.updateOne).not.toHaveBeenCalled();
    expect(missionEvidence.insertOne).not.toHaveBeenCalled();
    expect(externalWork.updateOne).not.toHaveBeenCalled();
  });
  it('returns complete retained output and exact input without delivery mutation', async () => {
    const result = await service.getGlassHiveWorkResult({ ownerId: 'owner-a', runId: 'run-a' });
    expect(result.outputText.length).toBeGreaterThan(12000);
    expect(result.outputText).toBe(row.evidence);
    expect(result.runInput?.instruction).toBe(original);
    expect(result).not.toHaveProperty('secret');
    expect(result.resultRevision).toBe(3);
    expect(missionEvidence.findOne).toHaveBeenCalledWith(
      { ownerId: 'owner-a', runId: 'run-a' },
      { sort: { terminalCallbackResultRevision: -1 } },
    );
    expect(externalWork.findOne).not.toHaveBeenCalled();
  });
  it('labels the retained terminal result when corrected work is now running', async () => {
    externalWork.findOne.mockResolvedValue({
      ownerId: 'owner-a',
      workRef: 'work-a',
      terminalCallbackRunId: 'run-a',
      runId: 'run-new-correction',
      state: 'running',
    });
    await expect(
      service.getGlassHiveWorkResult({ ownerId: 'owner-a', workRef: 'work-a' }),
    ).resolves.toMatchObject({
      runId: 'run-a',
      resultWorkState: 'completed',
      selection: 'latest_retained_terminal_result',
      currentRunMatch: 'unverified',
    });
    expect(missionEvidence.findOne).toHaveBeenCalledWith(
      { ownerId: 'owner-a', workRef: 'work-a', runId: 'run-a' },
      { sort: { terminalCallbackResultRevision: -1 } },
    );
  });
  it.each([
    null,
    { ...row, ownerId: 'owner-b' },
    { ...row, runId: 'run-b' },
    { ...row, workRef: 'work-b' },
  ])('rejects missing or mismatched retained evidence without disclosing it', async (value) => {
    missionEvidence.findOne.mockResolvedValue(value);
    await expect(
      service.getGlassHiveWorkResult({ ownerId: 'owner-a', runId: 'run-a', workRef: 'work-a' }),
    ).rejects.toMatchObject({ code: 'retained_work_result_not_found' });
  });
  it('does not substitute another goal when legacy input is absent', async () => {
    missionEvidence.findOne.mockResolvedValue({ ...row, runInput: undefined });
    await expect(
      service.getGlassHiveWorkResult({ ownerId: 'owner-a', runId: 'run-a' }),
    ).resolves.toMatchObject({ runInput: null, outputText: row.evidence });
  });
  it('rejects mismatched accepted input identity', async () => {
    missionEvidence.findOne.mockResolvedValue({
      ...row,
      runInput: { ...row.runInput, run_id: 'run-other' },
    });
    await expect(
      service.getGlassHiveWorkResult({ ownerId: 'owner-a', runId: 'run-a' }),
    ).rejects.toMatchObject({ code: 'mission_input_identity_invalid' });
  });
  it('preserves verified artifact references without exposing raw row fields', async () => {
    const sha = 'a'.repeat(64);
    const media = {
      observations: [
        {
          kind: 'image',
          source: 'native_tool_result',
          artifact_ref: `artifact_sha256:${sha}`,
          run_id: 'run-a',
          tool_call_id: 'call-a',
          content_index: 0,
          mime_type: 'image/png',
          bytes: 30,
          sha256: sha,
          download_url: 'https://example.test/artifacts/download',
          open_url: 'https://example.test/artifacts/open',
        },
      ],
      omitted_count: 0,
    };
    missionEvidence.findOne.mockResolvedValue({ ...row, nativeMedia: media });
    const result = await service.getGlassHiveWorkResult({ ownerId: 'owner-a', runId: 'run-a' });
    expect(result.nativeMedia).toEqual(media);
  });
  it('rejects a foreign current pointer and never reads evidence', async () => {
    externalWork.findOne.mockResolvedValue({
      ownerId: 'owner-b',
      workRef: 'work-a',
      terminalCallbackRunId: 'run-a',
    });
    await expect(
      service.getGlassHiveWorkResult({ ownerId: 'owner-a', workRef: 'work-a' }),
    ).rejects.toMatchObject({ code: 'retained_work_result_not_found' });
    expect(missionEvidence.findOne).not.toHaveBeenCalled();
  });
  it('preserves exact retained HTML files and their original delivery scope without rebinding', async () => {
    const outputFiles = {
      version: 1 as const,
      owner_id: 'owner-a',
      run_id: 'run-a',
      attempt_id: 'attempt-a',
      callback_id: 'callback-a',
      origin_ref: 'origin-a',
      work_ref: 'work-a',
      result_revision: 3,
      result_digest: `sha256:${'b'.repeat(64)}`,
      files: [
        {
          filename: 'checklist.html',
          mime_type: 'text/html',
          bytes: 42,
          sha256: 'a'.repeat(64),
          download_url: 'https://example.test/files/checklist',
        },
      ],
    };
    missionEvidence.findOne.mockResolvedValue({
      ...row,
      conversationId: 'old-chat',
      destinations: [{ surface: 'telegram' }, { surface: 'librechat' }],
      originRef: 'origin-a',
      attemptId: 'attempt-a',
      terminalCallbackId: 'callback-a',
      terminalCallbackResultDigest: outputFiles.result_digest,
      outputFiles,
    });
    const result = await service.getGlassHiveWorkResult({ ownerId: 'owner-a', runId: 'run-a' });
    expect(result.outputFiles).toEqual(outputFiles);
    expect(result.deliveryScope).toEqual({
      originConversationId: 'old-chat',
      destinations: ['telegram', 'librechat'],
      resultRunId: 'run-a',
      resultRevision: 3,
    });
    expect(result.currentRunMatch).toBe('unverified');
    expect(result).not.toHaveProperty('currentConversationDelivered');
  });
  it('rejects foreign file authority even when retained text belongs to the owner', async () => {
    missionEvidence.findOne.mockResolvedValue({
      ...row,
      originRef: 'origin-a',
      attemptId: 'attempt-a',
      terminalCallbackId: 'callback-a',
      terminalCallbackResultDigest: `sha256:${'b'.repeat(64)}`,
      outputFiles: {
        version: 1,
        owner_id: 'owner-b',
        run_id: 'run-a',
        attempt_id: 'attempt-a',
        callback_id: 'callback-a',
        origin_ref: 'origin-a',
        work_ref: 'work-a',
        result_revision: 3,
        result_digest: `sha256:${'b'.repeat(64)}`,
        files: [],
      },
    });
    await expect(
      service.getGlassHiveWorkResult({ ownerId: 'owner-a', runId: 'run-a' }),
    ).rejects.toMatchObject({ code: 'native_output_files_identity_invalid' });
  });
});
