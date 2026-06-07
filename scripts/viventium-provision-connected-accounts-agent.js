/* Historical provisioner for the retired "Connected Accounts" hand-off agent.
 *
 * Current GlassHive broker-first policy does not use this hand-off. Connected-account work should
 * go through the GlassHive worker broker, which projects user-scoped MCP capability without making
 * an in-process LibreChat hand-off agent decide the tool path.
 *
 * This script now refuses to provision by default so local QA or an old handoff note cannot
 * accidentally recreate the rejected shortcut. Set VIVENTIUM_ENABLE_RETIRED_CONNECTED_ACCOUNTS_HANDOFF=1
 * only for historical comparison/debugging.
 *
 * Original behavior: provision a read-only Google/MS365 hand-off agent + grant ACL,
 * and set a single handoff edge from the main agent to it. Idempotent and surgical: touches
 * ONLY the new agent and the main agent's edges, never the (drifted) Google/MS365 specialists.
 * Reuses LibreChat's createAgent + AclEntry path (mirrors viventium-sync-agents.js create logic),
 * so a single agent can be provisioned without the full-push that the specialist drift blocks.
 * Owner resolves from the main agent's author (override: VIVENTIUM_PROVISION_OWNER_ID).
 * Usage: node scripts/viventium-provision-connected-accounts-agent.js */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (process.env.VIVENTIUM_ENABLE_RETIRED_CONNECTED_ACCOUNTS_HANDOFF !== '1') {
  console.log(
    'SKIPPED retired Connected Accounts hand-off provisioner. GlassHive broker-first is the supported path. ' +
      'Set VIVENTIUM_ENABLE_RETIRED_CONNECTED_ACCOUNTS_HANDOFF=1 only for historical comparison.',
  );
  process.exit(0);
}

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const mongoose = require('mongoose');
const { connectDb } = require('../api/db/connect');
const { createAgent, getAgent, updateAgent } = require('../api/models/Agent');
const { ResourceType, PrincipalType, PrincipalModel } = require('librechat-data-provider');

const MAIN_ID = process.env.VIVENTIUM_MAIN_AGENT_ID || 'agent_viventium_main_95aeb3';
const AGENT_ID = 'agent_viventium_connected_accounts_95aeb3';

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

const INSTRUCTIONS = [
  'You own live, read-only access to the user’s connected Google Workspace and Microsoft 365 accounts: Gmail, Outlook mail, Google/Microsoft calendars, Drive and OneDrive files, Docs, Sheets, and Excel.',
  '',
  'When the main agent hands a request to you, satisfy it directly with your connected tools and verified live results:',
  '- For a generic inbox/email question (e.g. "any new emails today?"), check BOTH Gmail and Outlook unless the user named one provider.',
  '- Prefer the correct provider’s tools; pull message/thread/file content only when needed to summarize.',
  '- Return a concise, user-facing summary: sender, subject, and a one-line gist; separate genuinely important/time-sensitive items from newsletters/noise. Do not dump raw API fields, tool names, OAuth details, server names, IDs, or any worker/run plumbing.',
  '',
  'You are READ-ONLY. Never send, reply, draft, delete, move, archive, mark-as-read, or otherwise modify anything. If the user wants a write/send action, say it needs explicit confirmation and will be handled through the confirmed write path — do not attempt it here.',
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
  } else {
    const authorName = (await User.findById(USER_ID, 'name').lean())?.name || '';
    const created = await createAgent({
      id: AGENT_ID,
      name: 'Connected Accounts',
      description:
        'Reads your connected Google Workspace and Microsoft 365 accounts (Gmail, Outlook, calendars, Drive/OneDrive, Docs/Sheets) directly and returns a concise summary. Read-only.',
      instructions: INSTRUCTIONS,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: { model: 'claude-opus-4-7', thinking: true, effort: 'high' },
      tools: READ_TOOLS,
      category: 'general',
      author: USER_ID,
      authorName,
    });
    console.log('CREATED', AGENT_ID, '_id=', String(created._id), 'tools=', (created.tools || []).length);
    const AclEntry = mongoose.models.AclEntry || mongoose.model('AclEntry');
    const AccessRole = mongoose.models.AccessRole || mongoose.model('AccessRole');
    const ownerRole = await AccessRole.findOne({ resourceType: 'agent', permBits: 15 }).lean();
    const agentDoc = await Agent.findOne({ id: AGENT_ID }).lean();
    if (ownerRole && agentDoc) {
      await AclEntry.findOneAndUpdate(
        { principalId: USER_ID, resourceType: ResourceType.AGENT, resourceId: agentDoc._id },
        {
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: USER_ID,
          resourceType: ResourceType.AGENT,
          resourceId: agentDoc._id,
          permBits: ownerRole.permBits,
          roleId: ownerRole._id,
          grantedBy: USER_ID,
          grantedAt: new Date(),
        },
        { upsert: true, new: true },
      );
      console.log('ACL_GRANTED permBits=', ownerRole.permBits);
    } else {
      console.log('ACL_SKIPPED ownerRole=', !!ownerRole, 'agentDoc=', !!agentDoc);
    }
  }

  const edge = {
    from: MAIN_ID,
    to: AGENT_ID,
    edgeType: 'handoff',
    description:
      'Hand off to Connected Accounts to check the user’s Gmail, Outlook, calendars, Drive/OneDrive, Docs/Sheets directly via connected tools. Use for any inbox/email/calendar/file question about the user’s own connected accounts.',
    prompt:
      'Handle the user’s connected-account request directly with your Google Workspace and Microsoft 365 read tools. For a generic inbox/email question, check BOTH Gmail and Outlook unless the user named one provider. Return a concise, user-facing summary; read-only.',
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
