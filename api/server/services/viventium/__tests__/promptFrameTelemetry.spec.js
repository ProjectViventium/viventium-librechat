/* === VIVENTIUM START ===
 * Tests: Prompt-frame telemetry metadata/redaction contract.
 * Added: 2026-05-07
 * === VIVENTIUM END === */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LOG_ENV,
  DEBUG_ENV,
  DEBUG_LOCAL_ENV,
  FILE_LOG_ENV,
  OBSERVABILITY_DIR_ENV,
  estimatePromptTokens,
  hashFile,
  redactPromptDebugText,
  countVoiceControlMarkers,
  summarizeLayers,
  PROMPT_FRAME_LAYERS,
  normalizeLayersToContract,
  normalizeMCPInstructionSources,
  buildPromptFrame,
  logPromptFrame,
  writePromptFrameFile,
} = require('../promptFrameTelemetry');

describe('promptFrameTelemetry', () => {
  const originalEnv = {
    [LOG_ENV]: process.env[LOG_ENV],
    [DEBUG_ENV]: process.env[DEBUG_ENV],
    [DEBUG_LOCAL_ENV]: process.env[DEBUG_LOCAL_ENV],
    [FILE_LOG_ENV]: process.env[FILE_LOG_ENV],
    [OBSERVABILITY_DIR_ENV]: process.env[OBSERVABILITY_DIR_ENV],
    VIVENTIUM_PROMPT_BUNDLE_PATH: process.env.VIVENTIUM_PROMPT_BUNDLE_PATH,
    CONFIG_PATH: process.env.CONFIG_PATH,
    CI: process.env.CI,
  };

  afterEach(() => {
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  test('redacts private prompt debug values without classifying user intent', () => {
    const userHome = '/' + ['Users', 'someone'].join('/');
    const linuxHome = '/' + ['home', 'someone', '.config', 'viventium', 'private.log'].join('/');
    const ownerEmail = ['owner', 'example.com'].join('@');
    const apiKey = 'sk' + '-' + 'testsecret123456';
    const bearerSecret = ['Bearer', 'abcdefghijklmnopqrstuvwxyz'].join(' ');
    const text = [
      `User: ${ownerEmail}`,
      `Path: ${userHome}/Documents/Viventium/private.txt`,
      `App Support: ${userHome}/Library/Application Support/Viventium/state/runtime/logs/api.log`,
      `Linux: ${linuxHome}`,
      'Temp: /tmp/viventium/private.log',
      'Windows: C:\\Users\\someone\\AppData\\Local\\Viventium\\private.log',
      'UNC: \\\\HOST\\Share\\Viventium\\private.log',
      `Auth: ${bearerSecret}`,
      `API: api_key=${apiKey}`,
      'UUID: 6a078d96-6884-4b3b-ae6a-456d4b9a3e31',
      'ObjectId: 661e2c7189abcdef01234567',
      'Telegram: 1234567890123',
    ].join('\n');

    const redacted = redactPromptDebugText(text);
    expect(redacted).not.toContain(ownerEmail);
    expect(redacted).not.toContain(userHome);
    expect(redacted).not.toContain('Application Support');
    expect(redacted).not.toContain(linuxHome);
    expect(redacted).not.toContain('/tmp/viventium');
    expect(redacted).not.toContain('C:\\Users');
    expect(redacted).not.toContain('\\\\HOST');
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redacted).not.toContain(apiKey);
    expect(redacted).not.toContain('6a078d96-6884-4b3b-ae6a-456d4b9a3e31');
    expect(redacted).not.toContain('661e2c7189abcdef01234567');
    expect(redacted).not.toContain('1234567890123');
    expect(redacted).toContain('[email]');
    expect(redacted).toContain('[local_path]');
    expect(redacted).toContain('Bearer [secret]');
    expect(redacted).toContain('api_key=[secret]');
    expect(redacted).toContain('[uuid]');
    expect(redacted).toContain('[object_id]');
    expect(redacted).toContain('[numeric_id]');
  });

  test('summarizes layer tokens and hashes without returning raw text', () => {
    const layers = {
      main: 'System prompt with private content',
      followup: 'Another layer',
    };

    const summary = summarizeLayers(layers);
    expect(summary.token_estimates.main).toBeGreaterThan(0);
    expect(summary.char_counts.followup).toBe('Another layer'.length);
    expect(summary.hashes.main).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(summary)).not.toContain('System prompt with private content');
  });

  test('builds separate source, compiled, live, and file hashes', () => {
    delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-prompt-frame-'));
    const sourceFile = path.join(tempDir, 'source.yaml');
    const runtimeConfigFile = path.join(tempDir, 'librechat.generated.yaml');
    fs.writeFileSync(sourceFile, 'instructions: test\n', 'utf8');
    fs.writeFileSync(runtimeConfigFile, 'version: 1.2.3\n', 'utf8');
    process.env.CONFIG_PATH = runtimeConfigFile;
    const libreChatRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
    const sourceOfTruthRoot = path.join(libreChatRoot, 'viventium', 'source_of_truth');

    const frame = buildPromptFrame({
      promptFamily: 'main_runtime',
      surface: 'telegram',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      layers: {
        system: 'hello',
      },
      sourceHashes: {
        source: 'sourcehash',
        compiled: 'compiledhash',
        live: 'livehash',
      },
      promptSourceFiles: {
        source_yaml: sourceFile,
      },
    });

    expect(frame.source_hashes).toEqual({
      source: 'sourcehash',
      compiled: 'compiledhash',
      live: 'livehash',
      agent_source: hashFile(path.join(sourceOfTruthRoot, 'local.viventium-agents.yaml')),
      librechat_source: hashFile(path.join(sourceOfTruthRoot, 'local.librechat.yaml')),
      compiled_runtime_config: hashFile(runtimeConfigFile),
      live_installed_runtime_config: hashFile(runtimeConfigFile),
      compiler_version: 'missing',
    });
    expect(frame.prompt_source_file_hashes.source_yaml).toBe(hashFile(sourceFile));
    expect(JSON.stringify(frame)).not.toContain(sourceFile);
  });

  test('normalizes prompt frame layers to the documented contract', () => {
    const normalized = normalizeLayersToContract({
      primary_final_instructions: 'main text',
      instructions_before_surface_injection: 'pre surface text',
      primary_run_instructions: 'run text',
      no_response_instructions: 'nta text',
      formatted_input_messages: [{ role: 'user', content: 'message context' }],
      telegram_text: 'surface text',
      activation_prompt: 'activate',
      cortex_instructions: 'execute',
      productivity_runtime_instructions: 'productivity runtime',
      file_context: 'file evidence',
      cortex_output_rules: 'output rules',
      recent_response: 'already said',
      unexpected_local_key: 'private shape',
    });

    expect(PROMPT_FRAME_LAYERS).toContain('main_instructions');
    expect(normalized.layers.main_instructions).toContain('main text');
    expect(normalized.layers.main_instructions).toContain('pre surface text');
    expect(normalized.layers.main_instructions).toContain('run text');
    expect(normalized.layers.global_no_response).toContain('nta text');
    expect(normalized.layers.background_context).toContain('message context');
    expect(normalized.layers.background_context).toContain('file evidence');
    expect(normalized.layers.surface_prompt).toContain('surface text');
    expect(normalized.layers.cortex_activation).toContain('activate');
    expect(normalized.layers.cortex_execution).toContain('execute');
    expect(normalized.layers.cortex_execution).toContain('productivity runtime');
    expect(normalized.layers.cortex_execution).toContain('output rules');
    expect(normalized.layers.followup).toContain('already said');
    expect(normalized.unknown_layer_names).toEqual(['unexpected_local_key']);

    const frame = buildPromptFrame({
      promptFamily: 'test',
      layers: normalized.layers,
    });
    expect(Object.keys(frame.layer_token_estimates)).toEqual(PROMPT_FRAME_LAYERS);
    expect(frame.layer_contract_version).toBe(1);
  });

  test('counts voice provider-control markers', () => {
    const counts = countVoiceControlMarkers(
      '[warm] [NTA] [email] [uuid] Hello <break time="300ms"/> <prosody rate="slow">now</prosody> <say-as interpret-as="characters">AI</say-as>',
    );

    expect(counts.break_tags).toBe(1);
    expect(counts.prosody_tags).toBe(2);
    expect(counts.say_as_tags).toBe(2);
    expect(counts.emotion_tags).toBe(1);
    expect(counts.total).toBe(6);
  });

  test('records MCP instruction source metadata without raw prompt text', () => {
    const sources = normalizeMCPInstructionSources({
      scheduling: 'server_fetched',
      glasshive: 'config_inline',
      broken: 'unexpected',
      'bad key with spaces': 'server_fetched',
    });

    expect(sources).toEqual({
      scheduling: 'server_fetched',
      glasshive: 'config_inline',
      broken: 'missing',
      bad_key_with_spaces: 'server_fetched',
    });

    const frame = buildPromptFrame({
      promptFamily: 'main_assembly',
      layers: {
        mcp_server_instructions: 'Private MCP instruction text',
      },
      mcpInstructionSources: sources,
    });
    expect(frame.mcp_instruction_sources).toEqual(sources);
    expect(JSON.stringify(frame.mcp_instruction_sources)).not.toContain('Private MCP instruction text');
  });

  test('debug redacted layers require both debug and local gates', () => {
    process.env[DEBUG_ENV] = '1';
    delete process.env[DEBUG_LOCAL_ENV];
    const ownerEmail = ['owner', 'example.com'].join('@');

    let frame = buildPromptFrame({
      promptFamily: 'test',
      layers: {
        raw: ownerEmail,
      },
    });
    expect(frame.debug_redacted_layers).toBeUndefined();

    process.env[DEBUG_LOCAL_ENV] = '1';
    frame = buildPromptFrame({
      promptFamily: 'test',
      layers: {
        raw: ownerEmail,
      },
    });
    expect(frame.debug_redacted_layers.unknown).toContain('[email]');
  });

  test('local debug layer limit can hold full assembled prompt evidence', () => {
    process.env[DEBUG_ENV] = '1';
    process.env[DEBUG_LOCAL_ENV] = '1';
    process.env.VIVENTIUM_PROMPT_FRAME_DEBUG_CHAR_LIMIT = '200000';
    const longPrompt = 'A'.repeat(80_000);

    const frame = buildPromptFrame({
      promptFamily: 'test',
      layers: {
        main_instructions: longPrompt,
      },
    });

    expect(frame.debug_redacted_layers.main_instructions).toHaveLength(longPrompt.length);
    expect(frame.debug_redacted_layers.main_instructions).not.toContain('[truncated]');
  });

  test('logging can be disabled and never mutates frame shape', () => {
    const logger = {
      info: jest.fn(),
    };
    const frame = buildPromptFrame({
      promptFamily: 'test',
      layers: {
        raw: 'hello',
      },
    });

    process.env[LOG_ENV] = '0';
    expect(logPromptFrame(logger, frame)).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();

    process.env[LOG_ENV] = '1';
    expect(logPromptFrame(logger, frame)).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).not.toContain('hello');
  });

  test('normal logger omits local debug prompt layers even when debug mode is enabled', () => {
    const logger = {
      info: jest.fn(),
    };
    process.env[DEBUG_ENV] = '1';
    process.env[DEBUG_LOCAL_ENV] = '1';
    process.env[LOG_ENV] = '1';

    const frame = buildPromptFrame({
      promptFamily: 'test',
      layers: {
        main_instructions: 'private prompt text',
      },
    });

    expect(frame.debug_redacted_layers.main_instructions).toContain('private prompt text');
    expect(logPromptFrame(logger, frame)).toBe(true);
    expect(logger.info.mock.calls[0][0]).not.toContain('debug_redacted_layers');
    expect(logger.info.mock.calls[0][0]).not.toContain('private prompt text');
  });

  test('token estimate is monotonic with prompt size', () => {
    expect(estimatePromptTokens('abcd')).toBeLessThan(estimatePromptTokens('abcd'.repeat(10)));
  });

  test('local file logging writes private JSONL outside normal logger path', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-prompt-observability-'));
    process.env[FILE_LOG_ENV] = '1';
    process.env[OBSERVABILITY_DIR_ENV] = tempDir;
    process.env.CI = '';

    const frame = buildPromptFrame({
      promptFamily: 'test',
      surface: 'web',
      layers: {
        raw: 'hello',
      },
    });

    expect(writePromptFrameFile(frame)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const frameLogRoot = path.join(tempDir, 'frame-logs');
    const files = fs
      .readdirSync(frameLogRoot, { recursive: true })
      .filter((name) => String(name).endsWith('.jsonl'));
    expect(files.length).toBe(1);
    const logText = fs.readFileSync(path.join(frameLogRoot, files[0]), 'utf8');
    expect(logText).toContain('"event":"viventium.prompt_frame"');
    expect(logText).not.toContain('/' + 'Users' + '/');
  });

  test('local file logging refuses CI mode', () => {
    process.env[FILE_LOG_ENV] = '1';
    process.env.CI = 'true';

    const frame = buildPromptFrame({
      promptFamily: 'test',
      layers: {
        raw: 'hello',
      },
    });

    expect(writePromptFrameFile(frame)).toBe(false);
  });
});
