/* === VIVENTIUM START === Shared pure saved-memory receipt projection. === */
const { Tools, alternateName } = require('librechat-data-provider');
const MEMORY_RECEIPT_MAX_KEYS = 12;
const providerNames = new Map(
  Object.entries(alternateName).map(([provider, providerLabel]) => [
    provider.toLowerCase(),
    { provider, providerLabel },
  ]),
);

function memoryReceiptFromAttachments(attachments) {
  const artifacts = (Array.isArray(attachments) ? attachments : [])
    .map((attachment) => attachment?.[Tools.memory])
    .filter((artifact) => artifact && typeof artifact === 'object');
  if (artifacts.length === 0) {
    return null;
  }
  const keys = [];
  const failures = [];
  let hasPartialApply = false;
  let isUncertain = false;
  for (const artifact of artifacts) {
    const type = String(artifact.type || '');
    if (type === 'error') {
      let details = {};
      try {
        details = JSON.parse(String(artifact.value ?? '')) || {};
      } catch {
        details = {};
      }
      const failure = {
        errorType: typeof details.errorType === 'string' ? details.errorType : 'memory_error',
        ...(typeof details.provider === 'string'
          ? providerNames.get(details.provider.toLowerCase())
          : {}),
        partialApplied: details.partialApplied === true,
      };
      failures.push(failure);
      hasPartialApply ||= failure.partialApplied;
      isUncertain ||= failure.partialApplied && failure.errorType === 'writer_interrupted';
      continue;
    }
    const key = String(artifact.key || '').trim();
    if (
      (type === 'update' || type === 'delete') &&
      key &&
      key !== 'system' &&
      !keys.includes(key)
    ) {
      keys.push(key);
    }
  }
  if (failures.length > 0) {
    let status = 'failed';
    if (hasPartialApply || keys.length > 0) status = 'partial';
    if (isUncertain) status = 'uncertain';
    return {
      status,
      keys: keys.slice(0, MEMORY_RECEIPT_MAX_KEYS),
      errorType: failures[failures.length - 1].errorType,
      failures,
    };
  }
  if (keys.length === 0) {
    return artifacts.some((artifact) => artifact.type === 'unchanged')
      ? { status: 'unchanged', keys: [] }
      : null;
  }
  return { status: 'saved', keys: keys.slice(0, MEMORY_RECEIPT_MAX_KEYS) };
}

module.exports = { memoryReceiptFromAttachments };
