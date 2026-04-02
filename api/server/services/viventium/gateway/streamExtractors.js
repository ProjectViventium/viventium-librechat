/* === VIVENTIUM START ===
 * Feature: Gateway stream event extractors
 * Purpose: Normalize GenerationJobManager payloads into channel-friendly deltas/final text/attachments.
 * Added: 2026-02-19
 * === VIVENTIUM END === */

function collectTextParts(content) {
  const parts = [];
  if (typeof content === 'string') {
    if (content) {
      parts.push(content);
    }
    return parts;
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      parts.push(...collectTextParts(item));
    }
    return parts;
  }

  if (!content || typeof content !== 'object') {
    return parts;
  }

  if (content.type && content.type !== 'text') {
    return parts;
  }

  if (typeof content.text === 'string' && content.text) {
    parts.push(content.text);
    return parts;
  }

  if (content.text && typeof content.text === 'object' && typeof content.text.value === 'string') {
    parts.push(content.text.value);
    return parts;
  }

  if (typeof content.value === 'string' && content.value) {
    parts.push(content.value);
  }

  return parts;
}

function extractTextDeltas(payload = {}) {
  const deltas = [];

  if (typeof payload.text === 'string' && payload.text) {
    deltas.push(payload.text);
    return deltas;
  }

  if (payload.event !== 'on_message_delta') {
    return deltas;
  }

  const delta = payload?.data?.delta;
  if (!delta || typeof delta !== 'object') {
    return deltas;
  }

  const content = delta.content;
  if (!content) {
    return deltas;
  }

  return collectTextParts(content).filter((part) => typeof part === 'string' && part);
}

function extractFinalResponseText(payload = {}) {
  if (!payload.final) {
    return '';
  }

  const parts = [];
  const response = payload.responseMessage;
  if (response && typeof response === 'object') {
    if (typeof response.text === 'string' && response.text.trim()) {
      parts.push(response.text.trim());
    }

    if (parts.length === 0) {
      parts.push(...collectTextParts(response.content));
    }
  }

  if (parts.length === 0 && typeof payload.text === 'string' && payload.text.trim()) {
    parts.push(payload.text.trim());
  }

  return parts.join('').trim();
}

function extractResponseMessageId(payload = {}) {
  if (!payload.final) {
    return '';
  }

  const responseMessageId = payload?.responseMessage?.messageId;
  if (typeof responseMessageId === 'string' && responseMessageId) {
    return responseMessageId;
  }

  const fallback = payload.responseMessageId;
  if (typeof fallback === 'string' && fallback) {
    return fallback;
  }

  return '';
}

function isFileAttachmentPayload(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const fileId = value.file_id;
  if (typeof fileId === 'string' && fileId.trim()) {
    return true;
  }

  const filePath = value.filepath;
  if (typeof filePath === 'string' && filePath.trim()) {
    return true;
  }

  return false;
}

function extractAttachments(payload = {}) {
  const out = [];

  if (payload.event === 'attachment') {
    const data = payload.data;
    if (isFileAttachmentPayload(data)) {
      out.push(data);
      return out;
    }

    if (Array.isArray(data)) {
      return data.filter((item) => isFileAttachmentPayload(item));
    }

    return out;
  }

  if (!payload.final) {
    return out;
  }

  const responseAttachments = payload?.responseMessage?.attachments;
  if (Array.isArray(responseAttachments)) {
    out.push(...responseAttachments.filter((item) => isFileAttachmentPayload(item)));
  }

  if (Array.isArray(payload.attachments)) {
    out.push(...payload.attachments.filter((item) => isFileAttachmentPayload(item)));
  }

  return out;
}

function extractFinalError(payload = {}) {
  const topLevelError = payload.error;
  if (typeof topLevelError === 'string' && topLevelError.trim()) {
    return topLevelError.trim();
  }

  if (topLevelError && typeof topLevelError === 'object') {
    const message = topLevelError.message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }

  const response = payload.responseMessage;
  if (response && typeof response === 'object') {
    if (typeof response.errorMessage === 'string' && response.errorMessage.trim()) {
      return response.errorMessage.trim();
    }
  }

  return '';
}

module.exports = {
  collectTextParts,
  extractTextDeltas,
  extractFinalResponseText,
  extractResponseMessageId,
  extractAttachments,
  isFileAttachmentPayload,
  extractFinalError,
};
