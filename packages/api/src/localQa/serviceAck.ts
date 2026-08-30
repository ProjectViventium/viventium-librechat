/* === VIVENTIUM START ===
 * Feature: Fail-closed local-QA service startup acknowledgement.
 * Purpose: Prove that the listening Core process loaded the active private QA session.
 * === VIVENTIUM END === */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SERVICE_ID = 'librechat-core';
const HELPER_TIMEOUT_MS = 5000;
const SAFE_FAILURE_MARKER = '[VIVENTIUM][local-qa-service-ack] acknowledgement_failed';

type Environment = Record<string, string | undefined>;
type FileSystemPort = Pick<
  typeof fs,
  'accessSync' | 'constants' | 'lstatSync' | 'realpathSync' | 'statSync'
>;
type SpawnPort = typeof spawnSync;
type LogPort = { error(message: string): unknown };
type AckStatus = { status: 'inactive' | 'failed' | 'acknowledged' | 'pending' };

export interface LocalQaServiceAckOptions {
  env?: Environment;
  executable?: string;
  fileSystem?: FileSystemPort;
  installedRoot?: string;
  log?: LogPort;
  pid?: number;
  spawn?: SpawnPort;
}
export interface LocalQaServiceAckServer {
  listening?: boolean;
  once(event: 'listening', listener: () => AckStatus): unknown;
}

export interface LocalQaServiceAckDependencies {
  installedRoot: string;
  log: LogPort;
  fileSystem?: FileSystemPort;
  spawn?: SpawnPort;
}

function hasActiveLocalQaSession(env: Environment): boolean {
  return Boolean(env.VIVENTIUM_LOCAL_QA_CASE_ID?.trim() && env.VIVENTIUM_LOCAL_QA_SESSION_REF?.trim());
}

function reportSafeFailure(log: LogPort): AckStatus {
  try {
    log.error(SAFE_FAILURE_MARKER);
  } catch {
    return { status: 'failed' };
  }
  return { status: 'failed' };
}

function resolveExecutableHelper({
  installedRoot,
  fileSystem,
}: {
  installedRoot: string;
  fileSystem: FileSystemPort;
}): string {
  const expectedHelper = path.join(
    installedRoot,
    'scripts',
    'viventium',
    'local_qa_service_ack.py',
  );
  const configuredStat = fileSystem.lstatSync(expectedHelper);
  if (!configuredStat.isFile() || configuredStat.isSymbolicLink()) {
    throw new Error('local_qa_service_ack_helper_invalid');
  }
  const resolvedHelper = fileSystem.realpathSync(expectedHelper);
  const helperStat = fileSystem.statSync(resolvedHelper);
  if (!path.isAbsolute(resolvedHelper) || !helperStat.isFile()) {
    throw new Error('local_qa_service_ack_helper_invalid');
  }
  fileSystem.accessSync(resolvedHelper, fileSystem.constants.X_OK);
  return resolvedHelper;
}

export function createLocalQaServiceAckService(dependencies: LocalQaServiceAckDependencies) {
  const defaultFileSystem = dependencies.fileSystem ?? fs;
  const defaultSpawn = dependencies.spawn ?? spawnSync;

  function acknowledgeLocalQaServiceStartup(options: LocalQaServiceAckOptions = {}): AckStatus {
    const env = options.env ?? (process.env as Environment);
    if (!hasActiveLocalQaSession(env)) {
      return { status: 'inactive' };
    }

    const fileSystem = options.fileSystem ?? defaultFileSystem;
    const log = options.log ?? dependencies.log;
    const spawn = options.spawn ?? defaultSpawn;
    const pid = options.pid ?? process.pid;
    const executable = options.executable ?? process.execPath;
    const installedRoot = options.installedRoot ?? dependencies.installedRoot;

    try {
      const helper = resolveExecutableHelper({ installedRoot, fileSystem });
      const result = spawn(
        helper,
        ['acknowledge', '--service-id', SERVICE_ID, '--pid', String(pid), '--executable', executable],
        {
          env: env as NodeJS.ProcessEnv,
          stdio: 'ignore',
          timeout: HELPER_TIMEOUT_MS,
          windowsHide: true,
        },
      );
      if (result.error || result.status !== 0) {
        return reportSafeFailure(log);
      }
      return { status: 'acknowledged' };
    } catch {
      return reportSafeFailure(log);
    }
  }

  function registerLocalQaServiceAck(
    server: LocalQaServiceAckServer | null | undefined,
    options: LocalQaServiceAckOptions = {},
  ): AckStatus {
    const env = options.env ?? (process.env as Environment);
    if (!hasActiveLocalQaSession(env)) {
      return { status: 'inactive' };
    }
    const acknowledgeAfterListening = () => acknowledgeLocalQaServiceStartup(options);
    if (server?.listening) {
      return acknowledgeAfterListening();
    }
    if (!server || typeof server.once !== 'function') {
      return reportSafeFailure(options.log ?? dependencies.log);
    }
    server.once('listening', acknowledgeAfterListening);
    return { status: 'pending' };
  }

  return { acknowledgeLocalQaServiceStartup, registerLocalQaServiceAck };
}
