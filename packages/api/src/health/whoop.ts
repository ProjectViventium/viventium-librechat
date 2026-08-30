/* === VIVENTIUM START ===
 * Feature: WHOOP owner onboarding command boundary.
 * Purpose: Broker the installed health courier without placing secrets, callbacks, or exports in
 * argv, environment variables, logs, or web responses.
 * === VIVENTIUM END === */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MAX_CALLBACK_CHARS = 16_384;
const WHOOP_AUTH_ORIGIN = 'https://api.prod.whoop.com';
const WHOOP_AUTH_PATH = '/oauth/oauth2/auth';
const API_RESOURCES = [
  'cycles',
  'recovery',
  'sleep',
  'workout',
  'profile',
  'body_measurement',
] as const;
const EXPORT_RESOURCES = ['physiological_cycles', 'sleeps', 'workouts', 'journal_entries'] as const;
const CHILD_ENV_ALLOWLIST = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'SHELL',
  'TMPDIR',
  'USER',
  'VIVENTIUM_APP_SUPPORT_DIR',
  'VIVENTIUM_CONFIG_FILE',
  'VIVENTIUM_ENV_FILE',
  'VIVENTIUM_ENV_LOCAL_FILE',
  'VIVENTIUM_REPO_ROOT',
  'VIVENTIUM_RUNTIME_DIR',
  'VIVENTIUM_STATE_ROOT',
] as const;

export interface HealthCommandRunner {
  run(args: string[], input?: string | Buffer): Promise<string>;
  start(args: string[], input?: string | Buffer): Promise<void>;
}

export class WhoopHealthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500,
  ) {
    super(message);
  }
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function safeString(value: unknown, maxLength = 128): string | null {
  return typeof value === 'string' && value.length <= maxLength ? value : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseObject(stdout: string): JsonRecord {
  if (!stdout || Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) {
    throw new WhoopHealthError(
      'invalid_component_response',
      'WHOOP health status was unavailable.',
      502,
    );
  }
  try {
    const value = JSON.parse(stdout);
    const record = asRecord(value);
    if (!record) {
      throw new Error('not_object');
    }
    return record;
  } catch {
    throw new WhoopHealthError(
      'invalid_component_response',
      'WHOOP health status was unavailable.',
      502,
    );
  }
}

function findRepoRoot(): string {
  const configured = process.env.VIVENTIUM_REPO_ROOT?.trim();
  const candidates = [
    configured,
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '../..'),
    path.resolve(__dirname, '../../../../../..'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'bin', 'viventium'))) {
      return path.resolve(candidate);
    }
  }
  throw new WhoopHealthError(
    'health_runtime_unavailable',
    'The local health runtime is unavailable.',
    503,
  );
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = CHILD_ENV_ALLOWLIST.reduce<NodeJS.ProcessEnv>((result, key) => {
    if (process.env[key]) {
      result[key] = process.env[key];
    }
    return result;
  }, {});
  environment.VIVENTIUM_APP_SUPPORT_DIR =
    process.env.VIVENTIUM_APP_SUPPORT_DIR?.trim() ||
    path.join(os.homedir(), 'Library', 'Application Support', 'Viventium');
  return environment;
}

function commandArguments(args: string[]): { executable: string; args: string[]; cwd: string } {
  const repoRoot = findRepoRoot();
  const executable = path.join(repoRoot, 'bin', 'viventium');
  return {
    executable,
    args: ['health', ...args],
    cwd: repoRoot,
  };
}

class LocalHealthCommandRunner implements HealthCommandRunner {
  async run(args: string[], input?: string | Buffer): Promise<string> {
    const command = commandArguments(args);
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: childEnvironment(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        if (!settled) {
          settled = true;
          reject(
            new WhoopHealthError(
              'health_command_timeout',
              'WHOOP health operation timed out.',
              504,
            ),
          );
        }
      }, COMMAND_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= MAX_STDOUT_BYTES) {
          stdout.push(chunk);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_STDERR_BYTES) {
          stderr.push(chunk);
        }
      });
      child.once('error', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(
            new WhoopHealthError(
              'health_runtime_unavailable',
              'The local health runtime is unavailable.',
              503,
            ),
          );
        }
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (settled) {
          return;
        }
        settled = true;
        if (stdoutBytes > MAX_STDOUT_BYTES || stderrBytes > MAX_STDERR_BYTES) {
          reject(
            new WhoopHealthError(
              'health_output_limit',
              'WHOOP health operation returned too much output.',
              502,
            ),
          );
          return;
        }
        if (code !== 0) {
          reject(
            new WhoopHealthError(
              'health_command_failed',
              'WHOOP health operation did not complete.',
              502,
            ),
          );
          return;
        }
        resolve(Buffer.concat(stdout).toString('utf8'));
      });
      child.stdin.once('error', () => undefined);
      child.stdin.end(input);
    });
  }

  async start(args: string[], input?: string | Buffer): Promise<void> {
    const command = commandArguments(args);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: childEnvironment(),
        shell: false,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      let accepted = false;
      let acceptanceTimer: NodeJS.Timeout | undefined;
      const lifetimeTimer = setTimeout(() => child.kill('SIGTERM'), COMMAND_TIMEOUT_MS);
      lifetimeTimer.unref();
      child.once('error', () => {
        clearTimeout(lifetimeTimer);
        if (acceptanceTimer) {
          clearTimeout(acceptanceTimer);
        }
        if (!accepted) {
          reject(
            new WhoopHealthError(
              'health_runtime_unavailable',
              'The local health runtime is unavailable.',
              503,
            ),
          );
        }
      });
      child.once('close', (code) => {
        clearTimeout(lifetimeTimer);
        if (acceptanceTimer) {
          clearTimeout(acceptanceTimer);
        }
        if (!accepted) {
          reject(
            new WhoopHealthError(
              code === 0 ? 'health_command_ended' : 'health_command_failed',
              'WHOOP health operation could not start.',
              502,
            ),
          );
        }
      });
      child.once('spawn', () => {
        child.stdin.once('error', () => undefined);
        child.stdin.end(input);
        acceptanceTimer = setTimeout(() => {
          accepted = true;
          resolve();
        }, 100);
      });
    });
  }
}

const defaultRunner = new LocalHealthCommandRunner();

function sanitizeResourceResults(
  value: unknown,
  allowed: readonly string[],
): Record<string, string> {
  const record = asRecord(value) ?? {};
  const result: Record<string, string> = {};
  for (const resource of allowed) {
    const status = safeString(record[resource], 64);
    if (status && /^[a-z0-9_-]+$/.test(status)) {
      result[resource] = status;
    }
  }
  return result;
}

function sanitizeCounts(value: unknown, allowed: readonly string[]): Record<string, number> {
  const record = asRecord(value) ?? {};
  const result: Record<string, number> = {};
  for (const resource of allowed) {
    const count = safeInteger(record[resource]);
    if (count != null) {
      result[resource] = count;
    }
  }
  return result;
}

function sanitizeRun(value: unknown): JsonRecord | null {
  const run = asRecord(value);
  if (!run) {
    return null;
  }
  const resources = Array.isArray(run.resources)
    ? run.resources.filter(
        (resource): resource is string =>
          typeof resource === 'string' &&
          [...API_RESOURCES, ...EXPORT_RESOURCES, 'export_bundle', 'export_file'].includes(
            resource as never,
          ),
      )
    : [];
  const resultAllowed = [...API_RESOURCES, ...EXPORT_RESOURCES, 'export_bundle', 'export_file'];
  return {
    startedAt: safeString(run.started_at),
    finishedAt: safeString(run.finished_at),
    status: safeString(run.status, 32),
    requestedStart: safeString(run.requested_start),
    requestedEnd: safeString(run.requested_end),
    resources,
    resourceResults: sanitizeResourceResults(run.resource_results, resultAllowed),
    resourceItemCounts: sanitizeCounts(run.resource_item_counts, API_RESOURCES),
    itemCount: safeInteger(run.item_count),
  };
}

export async function getWhoopStatus(runner: HealthCommandRunner = defaultRunner) {
  const payload = parseObject(await runner.run(['whoop', 'status']));
  if (payload.schema_version !== 1 || payload.provider !== 'whoop') {
    throw new WhoopHealthError(
      'invalid_component_response',
      'WHOOP health status was unavailable.',
      502,
    );
  }
  const state = safeString(payload.state, 64);
  const allowedStates = [
    'setup_required',
    'ready_to_authorize',
    'authorization_pending',
    'authorizing',
    'importing',
    'connected_no_data',
    'connected',
    'degraded',
  ];
  if (!state || !allowedStates.includes(state)) {
    throw new WhoopHealthError(
      'invalid_component_response',
      'WHOOP health status was unavailable.',
      502,
    );
  }
  const coverage = asRecord(payload.coverage) ?? {};
  const api = asRecord(coverage.api) ?? {};
  const exportCoverage = asRecord(coverage.export) ?? {};
  const sanitizedApi: Record<string, JsonRecord> = {};
  for (const resource of API_RESOURCES) {
    const row = asRecord(api[resource]) ?? {};
    sanitizedApi[resource] = {
      scope: safeString(row.scope, 64),
      status: safeString(row.status, 64),
      items: safeInteger(row.items),
    };
  }
  const sanitizedExport: Record<string, JsonRecord> = {};
  for (const resource of EXPORT_RESOURCES) {
    const row = asRecord(exportCoverage[resource]) ?? {};
    sanitizedExport[resource] = { status: safeString(row.status, 64) };
  }
  const schedule = asRecord(payload.schedule) ?? {};
  const onboarding = asRecord(payload.onboarding);
  const manualEvidence = asRecord(payload.manual_evidence) ?? {};
  return {
    schemaVersion: 1,
    provider: 'whoop' as const,
    state,
    clientConfigured: payload.client_configured === true,
    authorized: payload.authorized === true,
    authorizationRecoveryRequired: payload.authorization_recovery_required === true,
    requestedScopes: Array.isArray(payload.requested_scopes)
      ? payload.requested_scopes.filter(
          (scope): scope is string => typeof scope === 'string' && scope.length <= 64,
        )
      : [],
    grantedScopes: Array.isArray(payload.granted_scopes)
      ? payload.granted_scopes.filter(
          (scope): scope is string => typeof scope === 'string' && scope.length <= 64,
        )
      : [],
    coverage: { api: sanitizedApi, export: sanitizedExport },
    latestApiRun: sanitizeRun(payload.latest_api_run),
    latestSuccessfulApiRun: sanitizeRun(payload.latest_successful_api_run),
    latestExportRun: sanitizeRun(payload.latest_export_run),
    manualEvidence: {
      itemCount: safeInteger(manualEvidence.item_count) ?? 0,
      latestAt: safeString(manualEvidence.latest_at),
    },
    schedule: {
      state: safeString(schedule.state, 64),
      configured: schedule.configured === true,
      loaded: schedule.loaded === true,
    },
    onboarding: onboarding
      ? {
          phase: safeString(onboarding.phase, 64),
          status: safeString(onboarding.status, 32),
          updatedAt: safeString(onboarding.updated_at),
          errorCode: safeString(onboarding.error_code, 64),
        }
      : null,
    limitations: {
      stressMonitor: 'manual_evidence_only' as const,
      apiExportBoundary: 'official_sources_only' as const,
    },
  };
}

export async function configureWhoopClient(
  input: { clientId: string; clientSecret: string; redirectUri: string },
  runner: HealthCommandRunner = defaultRunner,
) {
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
  const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : '';
  const redirectUri = typeof input.redirectUri === 'string' ? input.redirectUri.trim() : '';
  if (!clientId || clientId.length > 512 || !clientSecret || clientSecret.length > 4096) {
    throw new WhoopHealthError(
      'invalid_client_configuration',
      'WHOOP client configuration is invalid.',
      422,
    );
  }
  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(redirectUri);
  } catch {
    throw new WhoopHealthError('invalid_redirect_uri', 'WHOOP redirect URI is invalid.', 422);
  }
  if (!['viventium:', 'https:'].includes(parsedRedirect.protocol) || redirectUri.length > 2048) {
    throw new WhoopHealthError('invalid_redirect_uri', 'WHOOP redirect URI is invalid.', 422);
  }
  const stdout = await runner.run(
    ['whoop', 'configure', '--json-stdin'],
    JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  );
  const payload = parseObject(stdout);
  if (payload.status !== 'configured') {
    throw new WhoopHealthError(
      'invalid_component_response',
      'WHOOP client could not be configured.',
      502,
    );
  }
  return {
    status: 'configured' as const,
    requestedScopes: Array.isArray(payload.requested_scopes)
      ? payload.requested_scopes.filter(
          (scope): scope is string => typeof scope === 'string' && scope.length <= 64,
        )
      : [],
  };
}

export async function beginWhoopAuthorization(runner: HealthCommandRunner = defaultRunner) {
  const payload = parseObject(await runner.run(['whoop', 'connect', '--json']));
  const authorizationUrl = safeString(payload.authorization_url, 16_384);
  let parsed: URL;
  try {
    parsed = new URL(authorizationUrl ?? '');
  } catch {
    throw new WhoopHealthError(
      'invalid_component_response',
      'WHOOP authorization could not start.',
      502,
    );
  }
  if (
    payload.status !== 'authorization_pending' ||
    parsed.origin !== WHOOP_AUTH_ORIGIN ||
    parsed.pathname !== WHOOP_AUTH_PATH
  ) {
    throw new WhoopHealthError(
      'invalid_component_response',
      'WHOOP authorization could not start.',
      502,
    );
  }
  return { status: 'authorization_pending' as const, authorizationUrl };
}

export async function completeWhoopOnboarding(
  callbackUrl: string,
  runner: HealthCommandRunner = defaultRunner,
) {
  if (typeof callbackUrl !== 'string' || !callbackUrl || callbackUrl.length > MAX_CALLBACK_CHARS) {
    throw new WhoopHealthError('invalid_callback', 'WHOOP callback is invalid.', 422);
  }
  try {
    const parsed = new URL(callbackUrl);
    if (!['viventium:', 'https:'].includes(parsed.protocol)) {
      throw new Error('invalid_protocol');
    }
  } catch {
    throw new WhoopHealthError('invalid_callback', 'WHOOP callback is invalid.', 422);
  }
  await runner.start(['whoop', 'onboard', '--callback-stdin'], `${callbackUrl}\n`);
  return { status: 'accepted' as const };
}

export async function importWhoopExport(
  bundle: Buffer,
  runner: HealthCommandRunner = defaultRunner,
) {
  if (!Buffer.isBuffer(bundle) || bundle.length === 0 || bundle.length > MAX_EXPORT_BYTES) {
    throw new WhoopHealthError('invalid_export', 'WHOOP export ZIP is invalid or too large.', 422);
  }
  const payload = parseObject(await runner.run(['import', 'whoop-export', '--stdin'], bundle));
  const recordCount = safeInteger(payload.record_count);
  const fileCount = safeInteger(payload.file_count);
  if (
    !['complete', 'already_imported'].includes(String(payload.status)) ||
    recordCount == null ||
    fileCount == null
  ) {
    throw new WhoopHealthError(
      'invalid_component_response',
      'WHOOP export import did not complete.',
      502,
    );
  }
  return {
    status: payload.status as 'complete' | 'already_imported',
    recordCount,
    fileCount,
    resourceFileCounts: sanitizeCounts(payload.resource_file_counts, [
      ...EXPORT_RESOURCES,
      'export_file',
    ]),
  };
}

export async function importWhoopEvidence(
  image: Buffer,
  mediaType: string,
  runner: HealthCommandRunner = defaultRunner,
) {
  if (
    !Buffer.isBuffer(image) ||
    image.length === 0 ||
    image.length > MAX_EVIDENCE_BYTES ||
    !['image/png', 'image/jpeg'].includes(mediaType)
  ) {
    throw new WhoopHealthError(
      'invalid_evidence',
      'WHOOP evidence must be a PNG or JPEG within the size limit.',
      422,
    );
  }
  const payload = parseObject(
    await runner.run(['import', 'whoop-evidence', '--stdin', '--media-type', mediaType], image),
  );
  const recordCount = safeInteger(payload.record_count);
  const itemCount = safeInteger(payload.item_count);
  if (payload.status !== 'complete' || recordCount == null || itemCount !== 1) {
    throw new WhoopHealthError(
      'invalid_component_response',
      'WHOOP evidence import did not complete.',
      502,
    );
  }
  return { status: 'complete' as const, recordCount, itemCount };
}

export async function disconnectWhoop(runner: HealthCommandRunner = defaultRunner) {
  await runner.run(['whoop', 'disconnect']);
  return { status: 'disconnected' as const, historyRetained: true as const };
}
