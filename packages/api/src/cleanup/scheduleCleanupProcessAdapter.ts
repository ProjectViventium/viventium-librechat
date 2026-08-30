import { lstatSync, realpathSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { CleanupMutationRequest, CleanupTargetRef, ScheduleCleanupAdapter } from './types';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const SAFE_ERROR = /^cleanup_[a-z0-9_]{1,120}$/;

interface BridgeResponse {
  status?: string;
  code?: string;
  result?: {
    applied?: boolean;
    revision?: number;
    tombstonedAt?: string;
    receiptSha256?: string;
    verifiedCount?: number;
  };
}

function assertOwnedFile(path: string, label: string, executable = false): string {
  if (!isAbsolute(path)) throw new Error(`${label}_path_invalid`);
  const metadata = lstatSync(path);
  const canonical = realpathSync(path);
  const target = lstatSync(canonical);
  if (!target.isFile() || metadata.isDirectory() || (target.mode & 0o022) !== 0) {
    throw new Error(`${label}_file_invalid`);
  }
  if (typeof process.getuid === 'function' && target.uid !== process.getuid()) {
    throw new Error(`${label}_owner_invalid`);
  }
  if (executable && (target.mode & 0o100) === 0) {
    throw new Error(`${label}_not_executable`);
  }
  return canonical;
}

function parseResponse(output: string): BridgeResponse {
  try {
    const value = JSON.parse(output) as BridgeResponse;
    if (!value || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new Error('cleanup_schedule_bridge_response_invalid');
  }
}

function waitForBridge(
  child: ChildProcessWithoutNullStreams,
  payload: string,
  timeoutMs: number,
): Promise<BridgeResponse> {
  return new Promise((resolveResponse, reject) => {
    let stdout = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, response?: BridgeResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveResponse(response || {});
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('cleanup_schedule_bridge_timeout'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('cleanup_schedule_bridge_response_too_large'));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', () => undefined);
    child.on('error', () => finish(new Error('cleanup_schedule_bridge_unavailable')));
    child.on('close', (code) => {
      try {
        const response = parseResponse(stdout.trim());
        if (code !== 0 || response.status !== 'ok') {
          finish(
            new Error(
              SAFE_ERROR.test(String(response.code || ''))
                ? response.code
                : 'cleanup_schedule_bridge_rejected',
            ),
          );
          return;
        }
        finish(undefined, response);
      } catch (error) {
        finish(
          error instanceof Error ? error : new Error('cleanup_schedule_bridge_response_invalid'),
        );
      }
    });
    child.stdin.end(payload, 'utf8');
  });
}

export function createScheduleCleanupProcessAdapter({
  pythonExecutable,
  bridgeModuleRoot,
  environment,
  timeoutMs = 30_000,
}: {
  pythonExecutable: string;
  bridgeModuleRoot: string;
  environment: { [key: string]: string | undefined };
  timeoutMs?: number;
}): ScheduleCleanupAdapter & { assertReady(): void } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error('cleanup_schedule_bridge_timeout_invalid');
  }

  function paths() {
    const python = assertOwnedFile(pythonExecutable, 'cleanup_schedule_python', true);
    const root = resolve(bridgeModuleRoot);
    const bridge = assertOwnedFile(
      resolve(root, 'scheduling_cortex', 'personal_account_cleanup_bridge.py'),
      'cleanup_schedule_bridge',
    );
    if (dirname(dirname(bridge)) !== root) throw new Error('cleanup_schedule_bridge_root_invalid');
    return { python, root };
  }

  async function invoke(action: 'tombstone_exact' | 'verify_operation', request: object) {
    const { python, root } = paths();
    const child = spawn(python, ['-m', 'scheduling_cortex.personal_account_cleanup_bridge'], {
      cwd: root,
      env: { ...environment, PYTHONPATH: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return waitForBridge(child, JSON.stringify({ action, request }), timeoutMs);
  }

  return {
    assertReady: () => {
      paths();
    },
    async tombstoneExact(
      input: CleanupMutationRequest & { ownerScopeHash: string; tombstonedAt: string },
    ) {
      const response = await invoke('tombstone_exact', input);
      const result = response.result;
      if (
        result?.applied !== true ||
        !Number.isSafeInteger(result.revision) ||
        typeof result.tombstonedAt !== 'string' ||
        !/^[a-f0-9]{64}$/.test(String(result.receiptSha256 || ''))
      ) {
        throw new Error('cleanup_schedule_bridge_receipt_invalid');
      }
      return {
        applied: true,
        revision: Number(result.revision),
        tombstonedAt: result.tombstonedAt,
        receiptSha256: String(result.receiptSha256),
      };
    },
    async verifyOperation(input: {
      ownerId: string;
      operationId: string;
      targets: CleanupTargetRef[];
      nonceHash: string;
    }) {
      const response = await invoke('verify_operation', input);
      if (!Number.isSafeInteger(response.result?.verifiedCount)) {
        throw new Error('cleanup_schedule_bridge_verification_invalid');
      }
      return { verifiedCount: Number(response.result?.verifiedCount) };
    },
  };
}
