/* === VIVENTIUM START === Owner-scoped, read-only retained mission results. === */
import { normalizeGlassHiveRunInput } from './missionInput';
import { normalizeGlassHiveNativeMedia } from './nativeMedia';
import type { GlassHiveRunInput } from './missionInput';
import type { GlassHiveNativeMedia } from './nativeMedia';

interface ResultIdentity {
  ownerId: string;
  runId?: string;
  workRef?: string;
}
interface RetainedResult {
  ownerId: string;
  runId: string;
  workRef: string;
  workState?: string;
  state?: string;
  evidence?: string;
  runInput?: GlassHiveRunInput;
  nativeMedia?: GlassHiveNativeMedia;
  terminalCallbackResultRevision?: number;
}
interface WorkPointer {
  ownerId: string;
  workRef: string;
  terminalCallbackRunId?: string;
}
interface ReadCollection<T> {
  findOne(
    filter: ResultIdentity,
    options?: { sort: { terminalCallbackResultRevision: -1 } },
  ): Promise<T | null>;
}
function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
const identifier = /^[A-Za-z0-9._:-]{1,160}$/;

export function createGlassHiveWorkResultService(
  missionEvidence: ReadCollection<RetainedResult>,
  externalWork: ReadCollection<WorkPointer>,
) {
  async function getGlassHiveWorkResult({ ownerId, runId, workRef }: ResultIdentity) {
    if (!ownerId || typeof ownerId !== 'string') throw failure('glasshive_owner_required');
    if (
      (!runId && !workRef) ||
      (runId && !identifier.test(runId)) ||
      (workRef && !identifier.test(workRef))
    )
      throw failure('retained_work_result_selector_invalid');
    let selectedRunId = runId;
    if (!selectedRunId) {
      const pointer = await externalWork.findOne({ ownerId, workRef });
      if (
        pointer?.ownerId !== ownerId ||
        pointer.workRef !== workRef ||
        !pointer.terminalCallbackRunId
      ) {
        throw failure('retained_work_result_not_found');
      }
      selectedRunId = pointer.terminalCallbackRunId;
    }
    const row = await missionEvidence.findOne(
      { ownerId, runId: selectedRunId, ...(workRef ? { workRef } : {}) },
      { sort: { terminalCallbackResultRevision: -1 } },
    );
    if (
      !row ||
      row.ownerId !== ownerId ||
      row.runId !== selectedRunId ||
      (workRef && row.workRef !== workRef)
    )
      throw failure('retained_work_result_not_found');
    if (typeof row.evidence !== 'string') throw failure('retained_work_result_unavailable');
    return {
      workRef: row.workRef,
      runId: row.runId,
      resultWorkState: row.workState || 'unknown',
      selection: runId ? 'exact_run' : 'latest_retained_terminal_result',
      currentRunMatch: 'unverified',
      deliveryState: row.state || 'unknown',
      runInput: normalizeGlassHiveRunInput(row.runInput, row.runId) || null,
      outputText: row.evidence,
      nativeMedia: normalizeGlassHiveNativeMedia(row.nativeMedia, row.runId) || null,
      resultRevision: row.terminalCallbackResultRevision ?? null,
    };
  }
  return { getGlassHiveWorkResult };
}
/* === VIVENTIUM END === */
