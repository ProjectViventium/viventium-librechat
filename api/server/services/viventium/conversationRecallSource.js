'use strict';

/* === VIVENTIUM START ===
 * Source metadata shared by indexed recall and direct Message retrieval. The host supplies
 * conversation addresses; source text cannot supply or replace this metadata.
 * === VIVENTIUM END === */
function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(value) {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function conversationRecallSourceUrl(conversationId, clientUrl = process.env.DOMAIN_CLIENT) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) return null;
  const sourcePath = `c/${encodeURIComponent(conversationId)}`;
  try {
    const base = new URL(clientUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null;
    base.search = '';
    base.hash = '';
    base.pathname = `${base.pathname.replace(/\/$/, '')}/`;
    return new URL(sourcePath, base).href;
  } catch {
    return null;
  }
}

function renderConversationRecallTurn({ message, content }) {
  const role = message?.isCreatedByUser ? 'user' : message?.sender || 'assistant';
  const timestamp = message?.createdAt ? new Date(message.createdAt).toISOString() : '';
  const conversation = message?.conversationId || 'unknown';
  const source = conversationRecallSourceUrl(message?.conversationId);
  return `<turn timestamp="${escapeXmlAttr(timestamp)}" conversation="${escapeXmlAttr(
    conversation,
  )}" role="${escapeXmlAttr(role)}"${source ? ` source="${escapeXmlAttr(source)}"` : ''}>\n${escapeXmlText(
    content,
  )}\n</turn>`;
}

module.exports = { conversationRecallSourceUrl, escapeXmlText, renderConversationRecallTurn };
