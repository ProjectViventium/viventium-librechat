/* === VIVENTIUM START ===
 * Feature: Owner-authenticated reviewed synthetic-QA cleanup HTTP contract.
 * Purpose: Keep input projection and public error responses in typed package code.
 * === VIVENTIUM END === */

import type {
  PersonalAccountCleanupExecuteInput,
  PersonalAccountCleanupSweepInput,
} from './personalAccountCleanupExecutor';
import type { CleanupBackupAuthority, CleanupOperationRegistration } from './types';

interface CleanupRequestBody {
  confirmation?: string;
  attemptId?: string;
  registration?: CleanupOperationRegistration;
  backupAuthority?: CleanupBackupAuthority;
  runNonce?: string;
}

interface CleanupHttpRequest {
  body?: CleanupRequestBody;
  user?: { id?: string | number };
}

interface CleanupHttpResponse {
  json(body: object): unknown;
  set(field: string, value: string): unknown;
  status(statusCode: number): CleanupHttpResponse;
}

type CleanupHttpNext = () => void;

export interface PersonalAccountCleanupHttpDependencies {
  executePersonalAccountCleanup(input: PersonalAccountCleanupExecuteInput): Promise<object>;
  verifyPersonalAccountCleanupSweep(input: PersonalAccountCleanupSweepInput): Promise<object>;
}

const SAFE_ERROR = /^cleanup_[a-z0-9_]{1,120}$/;

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String(error.code || '');
    if (SAFE_ERROR.test(code)) return code;
  }
  if (error instanceof Error && SAFE_ERROR.test(error.message)) return error.message;
  return 'cleanup_execution_failed';
}

function partialFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'PersonalAccountCleanupPartialFailure';
}

export function personalAccountCleanupPublicError(error: unknown): {
  status: number;
  body: { status: string; error: string };
} {
  const code = errorCode(error);
  if (partialFailure(error)) {
    return { status: 503, body: { status: 'partial_retryable', error: code } };
  }
  if (code === 'cleanup_authenticated_owner_mismatch') {
    return { status: 403, body: { status: 'rejected', error: code } };
  }
  if (
    code.includes('authority') ||
    code === 'cleanup_backup_external_verification_rejected' ||
    code === 'cleanup_reviewed_authorization_required'
  ) {
    return { status: 403, body: { status: 'rejected', error: code } };
  }
  if (code.includes('replayed') || code.includes('conflict') || code.includes('in_progress')) {
    return { status: 409, body: { status: 'rejected', error: code } };
  }
  if (code.includes('invalid') || code.includes('mismatch') || code.includes('required')) {
    return { status: 400, body: { status: 'rejected', error: code } };
  }
  return { status: 503, body: { status: 'unavailable', error: code } };
}

export function createPersonalAccountCleanupHttpHandlers(
  dependencies: PersonalAccountCleanupHttpDependencies,
) {
  function noStore(
    _req: CleanupHttpRequest,
    res: CleanupHttpResponse,
    next: CleanupHttpNext,
  ): void {
    res.set('Cache-Control', 'no-store, private');
    res.set('Pragma', 'no-cache');
    next();
  }

  async function execute(req: CleanupHttpRequest, res: CleanupHttpResponse): Promise<unknown> {
    try {
      const result = await dependencies.executePersonalAccountCleanup({
        authenticatedOwnerId: String(req.user?.id || ''),
        confirmation: req.body?.confirmation,
        attemptId: req.body?.attemptId,
        registration: req.body?.registration,
        backupAuthority: req.body?.backupAuthority,
      });
      return res.status(200).json(result);
    } catch (error) {
      const response = personalAccountCleanupPublicError(error);
      return res.status(response.status).json(response.body);
    }
  }

  async function sweep(req: CleanupHttpRequest, res: CleanupHttpResponse): Promise<unknown> {
    try {
      const result = await dependencies.verifyPersonalAccountCleanupSweep({
        authenticatedOwnerId: String(req.user?.id || ''),
        confirmation: req.body?.confirmation,
        registration: req.body?.registration,
        backupAuthority: req.body?.backupAuthority,
        runNonce: req.body?.runNonce,
      });
      return res.status(200).json(result);
    } catch (error) {
      const response = personalAccountCleanupPublicError(error);
      return res.status(response.status).json(response.body);
    }
  }

  return { noStore, execute, sweep };
}

/* === VIVENTIUM END === */
