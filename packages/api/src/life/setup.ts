import path from 'path';
import { z } from 'zod';
import { execFile } from 'child_process';

const stateSchema = z.object({
  enabled: z.boolean(),
  folder_configured: z.boolean(),
  intent_recorded: z.boolean(),
  intent: z
    .object({
      text: z.string(),
      recorded_at: z.string(),
      folder_count: z.number().int().nonnegative(),
    })
    .optional(),
});

export type LifeSetupAction = 'status' | 'enable' | 'disable' | 'save' | 'clear';

/** Run the existing owner, projecting only the remote-safe setup state. */
export async function runLifeSetup(action: LifeSetupAction, text?: string) {
  const root = process.env.VIVENTIUM_NATIVE_RELEASE_ROOT || process.env.VIVENTIUM_REPO_ROOT;
  const support = process.env.VIVENTIUM_APP_SUPPORT_DIR;
  if (!root || !support || !path.isAbsolute(root) || !path.isAbsolute(support)) {
    throw new Error('Life setup is not available on this installation.');
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'HOME',
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'USER',
    'VIVENTIUM_APP_SUPPORT_DIR',
    'VIVENTIUM_CONFIG_FILE',
    'VIVENTIUM_RUNTIME_DIR',
    'VIVENTIUM_PYTHON_BIN',
    'VIVENTIUM_LIFE_DIR',
  ]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  let args: string[] = [action];
  if (action === 'save') {
    args = ['intent', '--stdin-json'];
  }
  if (action === 'clear') {
    args = ['intent', '--clear'];
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      path.join(root, 'bin/viventium'),
      ['life', ...args, '--json'],
      { env, timeout: 20_000, maxBuffer: 32 * 1024 },
      (error, output) => {
        if (error) {
          reject(new Error('Life settings could not be saved. Check the Life folder on your Mac.'));
          return;
        }
        resolve(output);
      },
    );
    child.stdin?.end(action === 'save' ? JSON.stringify({ text }) : undefined);
  });
  const state = stateSchema.parse(JSON.parse(stdout));
  return {
    version: 1,
    enabled: state.enabled,
    folderConfigured: state.folder_configured,
    folderChoiceLocation: 'mac',
    notice: 'Choose folders in Life from the Viventium app on your Mac.',
    connector: 'none',
    intent: state.intent
      ? {
          text: state.intent.text,
          recordedAt: state.intent.recorded_at,
          folderCount: state.intent.folder_count,
        }
      : null,
  };
}
