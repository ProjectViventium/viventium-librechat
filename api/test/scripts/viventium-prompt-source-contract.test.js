/* === VIVENTIUM START ===
 * Purpose: Guard registry-owned connected-account prompt and capability source contracts.
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const sourcePath = (name) => path.join(__dirname, '../../../viventium/source_of_truth', name);

describe('Viventium prompt source contracts', () => {
  test('registry-owns the complete multi-account Connected Accounts contract', () => {
    const agentsSource = yaml.load(
      fs.readFileSync(sourcePath('local.viventium-agents.yaml'), 'utf8'),
    );
    const librechatSource = yaml.load(fs.readFileSync(sourcePath('local.librechat.yaml'), 'utf8'));
    const connectedId = 'agent_viventium_connected_accounts_95aeb3';
    const connectedSource = agentsSource.handoffAgents.find((agent) => agent.id === connectedId);
    const connectedPrompt = fs.readFileSync(
      sourcePath('prompts/handoff/connected_accounts.md'),
      'utf8',
    );
    const googlePrompt = fs.readFileSync(
      sourcePath('prompts/mcp/google_workspace_server.md'),
      'utf8',
    );

    expect(connectedSource.instructions).toEqual({
      promptRef: 'handoff.connected_accounts.execution',
    });
    expect(librechatSource.mcpServers.google_workspace.serverInstructions).toEqual({
      promptRef: 'mcp.google_workspace.server',
    });

    const primaryGoogleReadTools = [
      'sys__server__sys_mcp_google_workspace',
      'search_gmail_messages_mcp_google_workspace',
      'get_gmail_message_content_mcp_google_workspace',
      'get_gmail_messages_content_batch_mcp_google_workspace',
      'get_gmail_thread_content_mcp_google_workspace',
      'list_calendars_mcp_google_workspace',
      'get_events_mcp_google_workspace',
      'search_drive_files_mcp_google_workspace',
      'get_drive_file_content_mcp_google_workspace',
      'search_docs_mcp_google_workspace',
      'get_doc_content_mcp_google_workspace',
      'read_sheet_values_mcp_google_workspace',
    ];
    const secondaryGoogleReadTools = primaryGoogleReadTools.map((tool) => `${tool}_2`);

    expect(connectedSource.tools.slice(0, primaryGoogleReadTools.length)).toEqual(
      primaryGoogleReadTools,
    );
    expect(
      connectedSource.tools.slice(
        primaryGoogleReadTools.length,
        primaryGoogleReadTools.length + secondaryGoogleReadTools.length,
      ),
    ).toEqual(secondaryGoogleReadTools);
    expect(connectedSource.tools).toEqual(
      expect.arrayContaining([
        'sys__server__sys_mcp_ms-365',
        'send_gmail_message_mcp_google_workspace',
        'send_gmail_message_mcp_google_workspace_2',
      ]),
    );
    expect(connectedPrompt).toContain('independent authenticated account');
    expect(connectedPrompt).toContain('Unix epoch seconds');
    expect(connectedPrompt).toContain('Pacific time');
    expect(connectedPrompt).toContain(
      'Return concise verified evidence to the conscious Main Agent',
    );
    expect(googlePrompt).toContain(
      'Each configured connection is one independent authenticated account',
    );
    expect(googlePrompt).toContain('Unix epoch seconds');
    expect(googlePrompt).toContain('Pacific-time boundaries');
  });

  test('keeps GlassHive fallback and provider capability metadata typed and complete', () => {
    const agentsSource = yaml.load(
      fs.readFileSync(sourcePath('local.viventium-agents.yaml'), 'utf8'),
    );
    const librechatSource = yaml.load(fs.readFileSync(sourcePath('local.librechat.yaml'), 'utf8'));
    const capability = librechatSource.endpoints.agents.providerCapabilities['glasshive-harness'];

    expect(agentsSource.mainAgent.fallback_llm_model_parameters).toEqual({
      model: 'claude-code:opus',
      reasoning_effort: 'high',
    });
    expect(capability).toMatchObject({
      default_access: 'full',
      allow_full_access: true,
      messaging_delivery_disposition: true,
      messaging_delivery_disposition_version: 1,
    });
  });

  test('keeps Main final-only output and Deep Memory visible-evidence requirements explicit', () => {
    const agentsSource = yaml.load(
      fs.readFileSync(sourcePath('local.viventium-agents.yaml'), 'utf8'),
    );
    const deepMemoryId = 'agent_viventium_deep_memory_95aeb3';
    const deepMemoryCortex = agentsSource.mainAgent.background_cortices.find(
      (cortex) => cortex.agent_id === deepMemoryId,
    );

    expect(agentsSource.mainAgent.hide_sequential_outputs).toBe(true);
    expect(deepMemoryCortex).toMatchObject({
      activation: { enabled: true, mode: 'always' },
      result_evidence: {
        visible_insight_requires: [{ tool: 'file_search', receipt: 'non_empty_sources' }],
      },
    });
  });

  test('requires durable mission receipts instead of treating cortex cards as proof', () => {
    const runtimeCardGuard = fs.readFileSync(
      sourcePath('prompts/main/background_cortex_runtime_card_guard.md'),
      'utf8',
    );

    expect(runtimeCardGuard).toContain('is not a durable mission receipt');
    expect(runtimeCardGuard).toContain('use the exact delegation tool for that mission');
    expect(runtimeCardGuard).toContain('invoke one mission per objective');
    expect(runtimeCardGuard).toContain('Set `requiresHostAccess` only when the Worker itself');
    expect(runtimeCardGuard).toContain('Without that receipt, do not say the mission started');
    expect(runtimeCardGuard).toContain('current-turn delivery evidence for those exact results');
  });
});
