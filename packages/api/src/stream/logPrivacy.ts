import { createHash } from 'crypto';

export function privateStreamLogRef(label: string, value: unknown): string {
  const safeLabel = String(label || 'identifier')
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase();
  return `${safeLabel}_sha256=${createHash('sha256')
    .update(String(value ?? ''))
    .digest('hex')}`;
}

export function streamLogRef(streamId: string): string {
  return privateStreamLogRef('stream', streamId);
}

export function safeStreamLogError(error: unknown): { name: string; code: string } {
  const value =
    error && typeof error === 'object' ? (error as { name?: unknown; code?: unknown }) : {};
  return {
    name: String(value.name || 'Error').slice(0, 120),
    code: String(value.code || 'stream_operation_failed').slice(0, 120),
  };
}
