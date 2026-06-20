/* Provision the supported "Connected Accounts" hand-off agent (Google/MS365).
 *
 * This complements GlassHive rather than replacing it: immediate inbox/calendar/file checks and
 * explicitly confirmed email/calendar updates can return inline through the same-process handoff,
 * while long-running, document/report, browser/computer, co-work, and autonomous worker tasks still
 * belong to GlassHive.
 *
 * Idempotent and surgical: touches ONLY the Connected Accounts agent and the main agent's
 * Main_To_ConnectedAccounts edge, never the Google/MS365 specialist background agents.
 * Reuses LibreChat's createAgent + canonical permission grants (mirrors the agent controller),
 * so a single agent can be provisioned without the full-push that the specialist drift blocks.
 * Owner resolves from the main agent's author (override: VIVENTIUM_PROVISION_OWNER_ID).
 * Usage: node scripts/viventium-provision-connected-accounts-agent.js */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const mongoose = require('mongoose');
const { connectDb } = require('../api/db/connect');
const { createAgent, getAgent, updateAgent } = require('../api/models/Agent');
const {
  ResourceType,
  PrincipalType,
  AccessRoleIds,
} = require('librechat-data-provider');
const { grantPermission } = require('../api/server/services/PermissionService');

const MAIN_ID = process.env.VIVENTIUM_MAIN_AGENT_ID || 'agent_viventium_main_95aeb3';
const AGENT_ID = 'agent_viventium_connected_accounts_95aeb3';
const AGENT_PROVIDER = 'anthropic';
const AGENT_MODEL = 'claude-opus-4-8';
const AGENT_MODEL_PARAMETERS = { model: AGENT_MODEL, thinking: true, effort: 'high' };
const FALLBACK_LLM_PROVIDER = 'openAI';
const FALLBACK_LLM_MODEL = 'gpt-5.4';
const FALLBACK_LLM_MODEL_PARAMETERS = { model: FALLBACK_LLM_MODEL };
const DESCRIPTION =
  'Uses your connected Google Workspace and Microsoft 365 accounts for quick inbox, calendar, and file checks, plus explicitly confirmed email/calendar updates.';

const READ_TOOLS = [
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
  'sys__server__sys_mcp_ms-365',
  'list-mail-messages_mcp_ms-365',
  'get-mail-message_mcp_ms-365',
  'list-mail-folder-messages_mcp_ms-365',
  'list-calendar-events_mcp_ms-365',
  'get-calendar-event_mcp_ms-365',
  'list-folder-files_mcp_ms-365',
  'download-onedrive-file-content_mcp_ms-365',
  'get-excel-range_mcp_ms-365',
  'search-query_mcp_ms-365',
];

const WRITE_TOOLS = [
  'send_gmail_message_mcp_google_workspace',
  'draft_gmail_message_mcp_google_workspace',
  'create_event_mcp_google_workspace',
  'modify_event_mcp_google_workspace',
  'create-draft-email_mcp_ms-365',
  'send-mail_mcp_ms-365',
  'list-calendars_mcp_ms-365',
  'get-calendar-view_mcp_ms-365',
  'create-calendar-event_mcp_ms-365',
  'update-calendar-event_mcp_ms-365',
  'list-specific-calendar-events_mcp_ms-365',
  'create-specific-calendar-event_mcp_ms-365',
  'get-specific-calendar-event_mcp_ms-365',
  'update-specific-calendar-event_mcp_ms-365',
];

const CONNECTED_ACCOUNT_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

const INSTRUCTIONS = [
  'You own live access to the user’s connected Google Workspace and Microsoft 365 accounts: Gmail, Outlook mail, Google/Microsoft calendars, Drive and OneDrive files, Docs, Sheets, and Excel.',
  '',
  'When the main agent hands a request to you, satisfy it directly with your connected tools and verified live results:',
  '- For a generic inbox/email question (e.g. "any new emails today?"), check BOTH Gmail and Outlook unless the user named one provider.',
  '- Prefer the correct provider’s tools; pull message/thread/file content only when needed to summarize.',
  '- Return a concise, user-facing summary: sender, subject, and a one-line gist; separate genuinely important/time-sensitive items from newsletters/noise. Do not dump raw API fields, account email addresses, aliases, tool names, OAuth details, server names, IDs, or any worker/run plumbing unless the user explicitly asks for diagnostic account details.',
  '',
  'Default to read-only inspection. For supported quick email/calendar writes, including drafting or sending email and creating or updating calendar events, act only when the user explicitly asked for that external action and the current thread contains clear approval/confirmation. If confirmation is missing or the impact/recipient/time is unclear, ask for the missing confirmation or detail instead of acting.',
  'After the user confirms a write action, use the connected Google/MS365 write tool directly when it supports the requested action. Do not say this path is read-only if the relevant write tool is present.',
  'For deleting, moving, archiving, marking read/unread, sharing, permission changes, broad file writes, or other destructive operations outside the listed email/calendar tools, ask for confirmation and use GlassHive or another write-capable path when the required direct tool is not available.',
  '',
  'If a tool errors, auth is missing/expired, scope is insufficient, or a provider is rate-limited or unavailable, say so plainly and report what you could and could not retrieve. Do not fabricate or fill gaps from memory.',
].join('\n');

(async () => {
  process.env.MONGO_URI =
    process.env.MONGO_URI || 'mongodb://127.0.0.1:27117/LibreChatViventium';
  await connectDb();
  const { Agent, User } = require('../api/db/models');

  // Resolve the owner from the main agent's author (or an explicit override) so this is portable.
  const mainAgent = await Agent.findOne({ id: MAIN_ID }, 'author').lean();
  const USER_ID = String(
    process.env.VIVENTIUM_PROVISION_OWNER_ID || (mainAgent && mainAgent.author) || '',
  ).trim();
  if (!USER_ID) {
    console.error('ERR cannot resolve owner (main agent author / VIVENTIUM_PROVISION_OWNER_ID)');
    process.exit(1);
  }

  const existing = await Agent.findOne({ id: AGENT_ID }).lean();
  if (existing) {
    console.log('AGENT_EXISTS', AGENT_ID, 'tools=', (existing.tools || []).length);
    await updateAgent(
      { id: AGENT_ID },
      {
        name: 'Connected Accounts',
        description: DESCRIPTION,
        instructions: INSTRUCTIONS,
        provider: AGENT_PROVIDER,
        model: AGENT_MODEL,
        model_parameters: AGENT_MODEL_PARAMETERS,
        fallback_llm_provider: FALLBACK_LLM_PROVIDER,
        fallback_llm_model: FALLBACK_LLM_MODEL,
        fallback_llm_model_parameters: FALLBACK_LLM_MODEL_PARAMETERS,
        tools: CONNECTED_ACCOUNT_TOOLS,
        category: 'general',
      },
    );
    console.log('UPDATED', AGENT_ID, 'tools=', CONNECTED_ACCOUNT_TOOLS.length);
  } else {
    const authorName = (await User.findById(USER_ID, 'name').lean())?.name || '';
    const created = await createAgent({
      id: AGENT_ID,
      name: 'Connected Accounts',
      description: DESCRIPTION,
      instructions: INSTRUCTIONS,
      provider: AGENT_PROVIDER,
      model: AGENT_MODEL,
      model_parameters: AGENT_MODEL_PARAMETERS,
      fallback_llm_provider: FALLBACK_LLM_PROVIDER,
      fallback_llm_model: FALLBACK_LLM_MODEL,
      fallback_llm_model_parameters: FALLBACK_LLM_MODEL_PARAMETERS,
      tools: CONNECTED_ACCOUNT_TOOLS,
      category: 'general',
      author: USER_ID,
      authorName,
    });
    console.log('CREATED', AGENT_ID, '_id=', String(created._id), 'tools=', (created.tools || []).length);
  }

  const agentDoc = await Agent.findOne({ id: AGENT_ID }).lean();
  if (agentDoc) {
    const AclEntry = mongoose.models.AclEntry || mongoose.model('AclEntry');
    await AclEntry.deleteMany({
      principalType: PrincipalType.USER,
      principalId: USER_ID,
      resourceType: { $in: [ResourceType.AGENT, ResourceType.REMOTE_AGENT] },
      resourceId: agentDoc._id,
    });
    await Promise.all([
      grantPermission({
        principalType: PrincipalType.USER,
        principalId: USER_ID,
        resourceType: ResourceType.AGENT,
        resourceId: agentDoc._id,
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        grantedBy: USER_ID,
      }),
      grantPermission({
        principalType: PrincipalType.USER,
        principalId: USER_ID,
        resourceType: ResourceType.REMOTE_AGENT,
        resourceId: agentDoc._id,
        accessRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
        grantedBy: USER_ID,
      }),
    ]);
    console.log('ACL_GRANTED canonical owner grants for agent and remoteAgent');
  } else {
    console.log('ACL_SKIPPED agentDoc=', !!agentDoc);
  }

  const edge = {
    from: MAIN_ID,
    to: AGENT_ID,
    edgeType: 'handoff',
    description:
      'Hand off to Connected Accounts for quick checks and explicitly confirmed email/calendar updates in the user’s Gmail, Outlook, calendars, Drive/OneDrive, Docs/Sheets via connected tools. Use for inbox/email/calendar/file lookups, status checks, summaries, and confirmed non-destructive email/calendar updates. Ask for confirmation before any external write.',
    prompt:
      'Handle the user’s connected-account request directly with your Google Workspace and Microsoft 365 tools. For generic inbox/email questions, check BOTH Gmail and Outlook unless the user named one provider. Default to read-only inspection. For sending/drafting email or creating/updating calendar events, use the relevant write tool only after explicit user confirmation and only when recipient/time/impact are clear; otherwise ask for the missing confirmation or detail. Route delete/move/archive/mark-read/sharing/permission/file-write operations to GlassHive or another confirmed write-capable path. Return a concise, user-facing result. Do not expose account email addresses, aliases, OAuth details, raw IDs, server names, or tool plumbing unless the user explicitly asks for diagnostic account details. Do not claim this path is read-only when a requested confirmed email/calendar write tool is present.',
    promptKey: 'Main_To_ConnectedAccounts',
  };
  const liveMainAgent = await getAgent({ id: MAIN_ID });
  const existingEdges = Array.isArray(liveMainAgent?.edges) ? liveMainAgent.edges : [];
  const mergedEdges = [
    ...existingEdges.filter((existingEdge) => existingEdge?.promptKey !== edge.promptKey),
    edge,
  ];
  await updateAgent({ id: MAIN_ID }, { edges: mergedEdges });
  console.log('MAIN_EDGE_SET to', AGENT_ID, 'preserved_edges=', existingEdges.length);

  await mongoose.disconnect();
  console.log('DONE');
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e && e.message);
  process.exit(1);
});
