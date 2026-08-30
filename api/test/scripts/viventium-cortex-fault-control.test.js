/* === VIVENTIUM START ===
 * Feature: EMO-UC-048 local-QA fault-control operator interface tests.
 * === VIVENTIUM END === */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, '../../../scripts/viventium-cortex-fault-control.js');
const MAX_INPUT_BYTES = 8 * 1024;

function createRealTempDirectory(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function scopeDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    scope: {
      ownerId: 'synthetic-owner',
      conversationId: 'synthetic-conversation',
      parentMessageId: 'synthetic-parent',
    },
    ...overrides,
  };
}

describe('viventium-cortex-fault-control', () => {
  test('accepts only a private structured-input channel, never raw scope argv', () => {
    const { parseArgs } = require(SCRIPT_PATH);
    expect(parseArgs(['arm', '--scope-fd', '3', '--json'])).toEqual({
      command: 'arm',
      scopeFd: 3,
      json: true,
    });
    expect(parseArgs(['query', '--scope-fd=3'])).toEqual({
      command: 'query',
      scopeFd: 3,
      json: false,
    });
    expect(() => parseArgs(['arm'])).toThrow('fault_control_scope_channel_required');
    expect(() => parseArgs(['query', '--scope-fd', '3', '--json', '--json'])).toThrow(
      'fault_control_arguments_invalid',
    );
    for (const duplicate of [
      ['--scope-fd', '3', '--scope-fd', '3'],
      ['--scope-fd=3', '--scope-fd=3'],
      ['--scope-fd', '3', '--scope-fd=3'],
      ['--scope-fd=3', '--scope-fd', '3'],
    ]) {
      expect(() => parseArgs(['query', ...duplicate])).toThrow('fault_control_arguments_invalid');
    }
    for (const forbidden of ['--owner-id', '--conversation-id', '--parent-message-id']) {
      expect(() => parseArgs(['query', forbidden, 'private-value'])).toThrow(
        'fault_control_arguments_invalid',
      );
    }
  });

  test('validates a closed structured scope document without a caller synthetic assertion', () => {
    const { parseStructuredInput } = require(SCRIPT_PATH);
    expect(
      parseStructuredInput('arm', {
        schemaVersion: 1,
        scope: {
          ownerId: 'synthetic-owner',
          conversationId: 'synthetic-conversation',
          parentMessageId: 'synthetic-parent',
        },
        boundary: 'cortex_ledger_first_write',
        ttlSeconds: 10,
      }),
    ).toEqual({
      ownerId: 'synthetic-owner',
      conversationId: 'synthetic-conversation',
      parentMessageId: 'synthetic-parent',
      boundary: 'cortex_ledger_first_write',
      expiresInMs: 10_000,
    });
    expect(() =>
      parseStructuredInput('arm', {
        schemaVersion: 1,
        scope: { ownerId: 'a', conversationId: 'b', parentMessageId: 'c' },
        boundary: 'cortex_ledger_first_write',
        syntheticScope: true,
      }),
    ).toThrow('structured input contains unsupported fields');
  });

  test('reads a 0600 scope file or private descriptor and rejects a public file', () => {
    const { readStructuredInput } = require(SCRIPT_PATH);
    const directory = createRealTempDirectory('emo048-cli-');
    const privateFile = path.join(directory, 'scope.json');
    const publicFile = path.join(directory, 'public.json');
    const document = JSON.stringify({
      schemaVersion: 1,
      scope: {
        ownerId: 'synthetic-owner',
        conversationId: 'synthetic-conversation',
        parentMessageId: 'synthetic-parent',
      },
    });
    fs.writeFileSync(privateFile, document, { mode: 0o600 });
    fs.writeFileSync(publicFile, document, { mode: 0o644 });
    const descriptor = fs.openSync(privateFile, 'r');
    try {
      expect(readStructuredInput({ command: 'query', scopeFile: privateFile })).toMatchObject({
        ownerId: 'synthetic-owner',
      });
      expect(readStructuredInput({ command: 'query', scopeFd: descriptor })).toMatchObject({
        conversationId: 'synthetic-conversation',
      });
      expect(() => readStructuredInput({ command: 'query', scopeFile: publicFile })).toThrow(
        'fault_control_scope_channel_not_private',
      );
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([
    ['0400', 0o400, false],
    ['0600', 0o600, true],
    ['0644', 0o644, false],
    ['0700', 0o700, false],
  ])('requires exact 0600 mode for a scope file (%s)', (_label, mode, accepted) => {
    const { readStructuredInput } = require(SCRIPT_PATH);
    const directory = createRealTempDirectory('emo048-cli-mode-');
    const scopeFile = path.join(directory, 'scope.json');
    fs.writeFileSync(
      scopeFile,
      JSON.stringify({
        schemaVersion: 1,
        scope: {
          ownerId: 'synthetic-owner',
          conversationId: 'synthetic-conversation',
          parentMessageId: 'synthetic-parent',
        },
      }),
      { mode: 0o600 },
    );
    fs.chmodSync(scopeFile, mode);
    try {
      if (accepted) {
        expect(readStructuredInput({ command: 'query', scopeFile })).toMatchObject({
          ownerId: 'synthetic-owner',
        });
      } else {
        expect(() => readStructuredInput({ command: 'query', scopeFile })).toThrow(
          'fault_control_scope_channel_not_private',
        );
      }
    } finally {
      fs.chmodSync(scopeFile, 0o600);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('accepts an owner-readable inherited descriptor with no group or other access', () => {
    const { readStructuredInput } = require(SCRIPT_PATH);
    const directory = createRealTempDirectory('emo048-cli-fd-mode-');
    const scopeFile = path.join(directory, 'scope.json');
    fs.writeFileSync(
      scopeFile,
      JSON.stringify({
        schemaVersion: 1,
        scope: {
          ownerId: 'synthetic-owner',
          conversationId: 'synthetic-conversation',
          parentMessageId: 'synthetic-parent',
        },
      }),
      { mode: 0o400 },
    );
    const descriptor = fs.openSync(scopeFile, 'r');
    try {
      expect(readStructuredInput({ command: 'query', scopeFd: descriptor })).toMatchObject({
        parentMessageId: 'synthetic-parent',
      });
    } finally {
      fs.closeSync(descriptor);
      fs.chmodSync(scopeFile, 0o600);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects unqualified stdin and emits no raw identifier', () => {
    const privateValues = ['owner-private', 'conversation-private', 'parent-private'];
    const argv = [SCRIPT_PATH, 'query'];
    const result = spawnSync(process.execPath, argv, {
      encoding: 'utf8',
      input: JSON.stringify({
        schemaVersion: 1,
        scope: {
          ownerId: privateValues[0],
          conversationId: privateValues[1],
          parentMessageId: privateValues[2],
        },
      }),
      env: {
        ...process.env,
        MONGO_URI: '',
        VIVENTIUM_LOCAL_MONGO_PORT: '',
        VIVENTIUM_LOCAL_MONGO_DB: '',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fault_control_scope_channel_required');
    for (const value of privateValues) {
      expect(argv).not.toContain(value);
      expect(result.stdout).not.toContain(value);
      expect(result.stderr).not.toContain(value);
    }
  });

  test('rejects redirected stdin even when it points to a readable public file', () => {
    const directory = createRealTempDirectory('emo048-cli-stdin-');
    const publicFile = path.join(directory, 'public.json');
    fs.writeFileSync(
      publicFile,
      JSON.stringify({
        schemaVersion: 1,
        scope: {
          ownerId: 'owner-private',
          conversationId: 'conversation-private',
          parentMessageId: 'parent-private',
        },
      }),
      { mode: 0o644 },
    );
    const stdinDescriptor = fs.openSync(publicFile, 'r');
    try {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, 'query'], {
        encoding: 'utf8',
        stdio: [stdinDescriptor, 'pipe', 'pipe'],
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fault_control_scope_channel_required');
      expect(result.stdout).not.toContain('owner-private');
      expect(result.stderr).not.toContain('owner-private');
    } finally {
      fs.closeSync(stdinDescriptor);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('serializes only redacted service output', () => {
    const { assertScopeAbsentFromArgv, serializeRedactedResult } = require(SCRIPT_PATH);
    const input = {
      ownerId: 'owner-private',
      conversationId: 'conversation-private',
      parentMessageId: 'parent-private',
    };
    const output = serializeRedactedResult(
      {
        ownerScopeHash: `sha256:${'a'.repeat(64)}`,
        conversationScopeHash: `sha256:${'b'.repeat(64)}`,
        parentScopeHash: `sha256:${'c'.repeat(64)}`,
      },
      input,
      false,
    );
    expect(output).toContain('ownerScopeHash');
    expect(() => serializeRedactedResult({ ownerId: input.ownerId }, input, false)).toThrow(
      'fault_control_output_not_redacted',
    );
    expect(() =>
      assertScopeAbsentFromArgv(['query', `--scope-file=/private/${input.parentMessageId}`], input),
    ).toThrow('fault_control_scope_present_in_argv');
  });

  test('rejects a symlink in any scope-file parent and a final symlink', () => {
    const { readStructuredInput } = require(SCRIPT_PATH);
    const directory = createRealTempDirectory('emo048-cli-symlink-');
    const realParent = path.join(directory, 'real-parent');
    const linkedParent = path.join(directory, 'linked-parent');
    const scopeFile = path.join(realParent, 'scope.json');
    const finalLink = path.join(directory, 'scope-link.json');
    fs.mkdirSync(realParent);
    fs.writeFileSync(scopeFile, JSON.stringify(scopeDocument()), { mode: 0o600 });
    fs.symlinkSync(realParent, linkedParent, 'dir');
    fs.symlinkSync(scopeFile, finalLink, 'file');
    try {
      expect(() =>
        readStructuredInput({ command: 'query', scopeFile: path.join(linkedParent, 'scope.json') }),
      ).toThrow('fault_control_scope_channel_invalid');
      expect(() => readStructuredInput({ command: 'query', scopeFile: finalLink })).toThrow(
        'fault_control_scope_channel_invalid',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects a hard-linked scope file', () => {
    const { readStructuredInput } = require(SCRIPT_PATH);
    const directory = createRealTempDirectory('emo048-cli-hardlink-');
    const scopeFile = path.join(directory, 'scope.json');
    const hardLink = path.join(directory, 'scope-hardlink.json');
    fs.writeFileSync(scopeFile, JSON.stringify(scopeDocument()), { mode: 0o600 });
    fs.linkSync(scopeFile, hardLink);
    try {
      expect(() => readStructuredInput({ command: 'query', scopeFile })).toThrow(
        'fault_control_scope_channel_invalid',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('the executable rejects a FIFO scope file without blocking', () => {
    const directory = createRealTempDirectory('emo048-cli-fifo-');
    const fifo = path.join(directory, 'scope.fifo');
    spawnSync('mkfifo', [fifo]);
    fs.chmodSync(fifo, 0o600);
    try {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, 'query', '--scope-file', fifo], {
        encoding: 'utf8',
        timeout: 1_000,
      });
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fault_control_scope_channel_invalid');
      expect(result.stderr).not.toContain(fifo);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects an oversized scope file without an unbounded whole-file read', () => {
    const { readStructuredInput } = require(SCRIPT_PATH);
    const directory = createRealTempDirectory('emo048-cli-oversized-file-');
    const scopeFile = path.join(directory, 'scope.json');
    fs.writeFileSync(scopeFile, Buffer.alloc(MAX_INPUT_BYTES + 1, 0x61), { mode: 0o600 });
    const wholeFileRead = jest.spyOn(fs, 'readFileSync');
    try {
      expect(() => readStructuredInput({ command: 'query', scopeFile })).toThrow(
        'fault_control_scope_document_invalid',
      );
      expect(wholeFileRead).not.toHaveBeenCalled();
    } finally {
      wholeFileRead.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('bounds a growing regular-file producer before whole-file allocation', () => {
    const { readStructuredInput } = require(SCRIPT_PATH);
    const directory = createRealTempDirectory('emo048-cli-producer-');
    const scopeFile = path.join(directory, 'scope.json');
    fs.writeFileSync(scopeFile, JSON.stringify(scopeDocument()), { mode: 0o600 });
    const descriptor = fs.openSync(scopeFile, 'r');
    const originalRead = fs.readSync;
    let expanded = false;
    const read = jest.spyOn(fs, 'readSync').mockImplementation((...args) => {
      if (!expanded) {
        expanded = true;
        fs.appendFileSync(scopeFile, Buffer.alloc(MAX_INPUT_BYTES + 1, 0x61));
      }
      return originalRead(...args);
    });
    try {
      expect(() => readStructuredInput({ command: 'query', scopeFd: descriptor })).toThrow(
        'fault_control_scope_document_invalid',
      );
    } finally {
      read.mockRestore();
      fs.closeSync(descriptor);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('the executable rejects a non-regular inherited descriptor with the typed contract error', () => {
    const directory = createRealTempDirectory('emo048-cli-pipe-fd-');
    const fifo = path.join(directory, 'scope.fifo');
    spawnSync('mkfifo', [fifo]);
    fs.chmodSync(fifo, 0o600);
    const readDescriptor = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const writeDescriptor = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(writeDescriptor, Buffer.from(JSON.stringify(scopeDocument())));
    fs.closeSync(writeDescriptor);
    try {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, 'query', '--scope-fd', '3'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe', readDescriptor],
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('{"ok":false,"error":"fault_control_scope_channel_invalid"}\n');
      expect(result.stderr).not.toContain(fifo);
      expect(result.stderr).not.toContain('synthetic-owner');
    } finally {
      fs.closeSync(readDescriptor);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects invalid UTF-8 and duplicate JSON keys before parsing scope', () => {
    const { readStructuredInput } = require(SCRIPT_PATH);
    const directory = createRealTempDirectory('emo048-cli-json-');
    const invalidUtf8 = path.join(directory, 'invalid-utf8.json');
    const duplicateJson = path.join(directory, 'duplicate.json');
    const prefix = Buffer.from('{"schemaVersion":1,"scope":{"ownerId":"owner-', 'utf8');
    const suffix = Buffer.from(
      '","conversationId":"synthetic-conversation","parentMessageId":"synthetic-parent"}}',
      'utf8',
    );
    fs.writeFileSync(invalidUtf8, Buffer.concat([prefix, Buffer.from([0xff]), suffix]), {
      mode: 0o600,
    });
    fs.writeFileSync(
      duplicateJson,
      '{"schemaVersion":1,"schemaVersion":1,"scope":{"ownerId":"synthetic-owner","conversationId":"synthetic-conversation","parentMessageId":"synthetic-parent"}}',
      { mode: 0o600 },
    );
    try {
      expect(() => readStructuredInput({ command: 'query', scopeFile: invalidUtf8 })).toThrow(
        'fault_control_scope_document_invalid',
      );
      expect(() => readStructuredInput({ command: 'query', scopeFile: duplicateJson })).toThrow(
        'fault_control_scope_document_invalid',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects a scope-file replacement during its bounded read', () => {
    const { readStructuredInput } = require(SCRIPT_PATH);
    const directory = createRealTempDirectory('emo048-cli-replace-');
    const scopeFile = path.join(directory, 'scope.json');
    const displacedFile = path.join(directory, 'scope-old.json');
    fs.writeFileSync(scopeFile, JSON.stringify(scopeDocument()), { mode: 0o600 });
    const originalRead = fs.readSync;
    let replaced = false;
    const read = jest.spyOn(fs, 'readSync').mockImplementation((...args) => {
      const count = originalRead(...args);
      if (!replaced) {
        replaced = true;
        fs.renameSync(scopeFile, displacedFile);
        fs.writeFileSync(scopeFile, JSON.stringify(scopeDocument()), { mode: 0o600 });
      }
      return count;
    });
    try {
      expect(() => readStructuredInput({ command: 'query', scopeFile })).toThrow(
        'fault_control_scope_channel_invalid',
      );
    } finally {
      read.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects noncanonical timestamps before executable output', () => {
    const { serializeRedactedResult } = require(SCRIPT_PATH);
    expect(() =>
      serializeRedactedResult(
        {
          armedAt: '2026-08-23T12:00:00.000Z',
          expiresAt: '2026-08-23T12:01:00.000+00:00',
          purgeAt: '2026-08-24T12:01:00.000+00:00',
          audit: [{ sequence: 1, event: 'armed', at: '2026-08-23T12:00:00.000+00:00' }],
        },
        {
          ownerId: 'owner-private',
          conversationId: 'conversation-private',
          parentMessageId: 'parent-private',
        },
        false,
      ),
    ).toThrow('fault_control_timestamp_invalid');
  });

  test('the executable accepts the root parent inherited-FD shape', () => {
    const directory = createRealTempDirectory('emo048-cli-root-fd-');
    const scopeFile = path.join(directory, 'scope.json');
    fs.writeFileSync(scopeFile, JSON.stringify(scopeDocument()), { mode: 0o600 });
    const descriptor = fs.openSync(scopeFile, 'r');
    try {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, 'query', '--scope-fd', '3'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          MONGO_URI: '',
          VIVENTIUM_LOCAL_MONGO_PORT: '',
          VIVENTIUM_LOCAL_MONGO_DB: '',
        },
        stdio: ['ignore', 'pipe', 'pipe', descriptor],
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fault_control_failed');
      expect(result.stderr).not.toContain('fault_control_scope_channel');
      expect(result.stdout).not.toContain('synthetic-owner');
      expect(result.stderr).not.toContain('synthetic-owner');
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('dispatches arm, query, and clear through one bounded service contract', async () => {
    const { executeCommand } = require(SCRIPT_PATH);
    const service = {
      arm: jest.fn().mockResolvedValue({ state: 'armed' }),
      query: jest.fn().mockResolvedValue([{ state: 'armed' }]),
      clear: jest.fn().mockResolvedValue({ cleared: 1 }),
    };
    const input = {
      ownerId: 'synthetic-owner',
      conversationId: 'synthetic-conversation',
      parentMessageId: 'synthetic-parent',
      boundary: 'cortex_ledger_first_write',
    };

    await expect(
      executeCommand(service, { command: 'arm' }, { ...input, expiresInMs: 10_000 }),
    ).resolves.toEqual({ state: 'armed' });
    await expect(executeCommand(service, { command: 'query' }, input)).resolves.toEqual([
      { state: 'armed' },
    ]);
    await expect(executeCommand(service, { command: 'clear' }, input)).resolves.toEqual({
      cleared: 1,
    });
    expect(service.arm).toHaveBeenCalledWith({
      boundary: 'cortex_ledger_first_write',
      ownerId: 'synthetic-owner',
      conversationId: 'synthetic-conversation',
      parentMessageId: 'synthetic-parent',
      expiresInMs: 10_000,
    });
  });
});
