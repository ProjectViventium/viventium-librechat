const originalFetch = globalThis.fetch;

function truncate(value, max = 160) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function summarizeBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks.slice(0, 8).map((block) => {
    if (block == null || typeof block !== 'object') {
      return { type: typeof block };
    }

    return {
      type: block.type,
      name: typeof block.name === 'string' ? block.name : undefined,
      text: typeof block.text === 'string' ? truncate(block.text) : undefined,
      hasInput: block.input != null,
      hasContent: Array.isArray(block.content),
    };
  });
}

function summarizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.slice(-4).map((message) => ({
    role: message?.role,
    content:
      typeof message?.content === 'string'
        ? truncate(message.content)
        : summarizeBlocks(message?.content),
  }));
}

function sanitizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of new Headers(headers || {}).entries()) {
    if (key.toLowerCase() === 'authorization') {
      normalized[key] = typeof value === 'string' ? `${value.slice(0, 20)}...` : value;
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function summarizeRequestBody(url, body) {
  if (typeof body !== 'string') {
    if (body instanceof URLSearchParams) {
      return truncate(body.toString(), 400);
    }
    return body == null ? null : String(body);
  }

  if (!url.includes('/v1/messages')) {
    return truncate(body, 800);
  }

  try {
    const parsed = JSON.parse(body);
    return {
      keys: Object.keys(parsed).sort(),
      model: parsed.model,
      max_tokens: parsed.max_tokens,
      temperature: parsed.temperature,
      thinking: parsed.thinking,
      tool_choice: parsed.tool_choice,
      tool_count: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      tool_names: Array.isArray(parsed.tools)
        ? parsed.tools
            .slice(0, 10)
            .map((tool) => tool?.name)
            .filter((name) => typeof name === 'string')
        : [],
      first_tool:
        Array.isArray(parsed.tools) && parsed.tools[0] != null
          ? {
              name: parsed.tools[0].name,
              type: parsed.tools[0].type,
              description: truncate(parsed.tools[0].description),
              input_schema:
                parsed.tools[0].input_schema != null
                  ? {
                      type: parsed.tools[0].input_schema.type,
                      keys:
                        parsed.tools[0].input_schema.properties != null
                          ? Object.keys(parsed.tools[0].input_schema.properties).slice(0, 12)
                          : [],
                    }
                  : undefined,
            }
          : null,
      system:
        typeof parsed.system === 'string'
          ? truncate(parsed.system)
          : summarizeBlocks(
              Array.isArray(parsed.system) ? parsed.system : parsed.system?.content,
            ),
      messages: summarizeMessages(parsed.messages),
    };
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error),
      raw: truncate(body, 1200),
    };
  }
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function debugAnthropicFetch(input, init) {
    const request = input instanceof Request ? input : null;
    const url = typeof input === 'string' ? input : request?.url;
    const method = init?.method || request?.method || 'GET';
    const headers = init?.headers || request?.headers;
    const body = init?.body;
    const shouldLog =
      typeof url === 'string' &&
      (url.includes('api.anthropic.com/v1/messages') ||
        url.includes('platform.claude.com/v1/oauth/token'));

    if (shouldLog) {
      console.error(
        `[anthropic-fetch-debug] request ${JSON.stringify({
          url,
          method,
          headers: sanitizeHeaders(headers),
          body: summarizeRequestBody(url, body),
        })}`,
      );
    }

    const response = await originalFetch(input, init);

    if (shouldLog) {
      const clone = response.clone();
      let responseBody;
      try {
        const text = await clone.text();
        responseBody = truncate(text, 2000);
      } catch (error) {
        responseBody = error instanceof Error ? error.message : String(error);
      }

      console.error(
        `[anthropic-fetch-debug] response ${JSON.stringify({
          url,
          status: response.status,
          statusText: response.statusText,
          body: responseBody,
        })}`,
      );
    }

    return response;
  };
}
