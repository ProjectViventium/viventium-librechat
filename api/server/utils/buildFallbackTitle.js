const { sanitizeTitle } = require('@librechat/api');

function buildFallbackTitle(text) {
  const normalizedText = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalizedText) {
    return 'New conversation';
  }

  const fallbackTitle =
    normalizedText.length > 40 ? `${normalizedText.slice(0, 37).trimEnd()}...` : normalizedText;

  return sanitizeTitle(fallbackTitle);
}

module.exports = buildFallbackTitle;
