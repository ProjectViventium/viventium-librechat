/* VIVENTIUM START: structured debug redaction no longer uses upstream object traversal. */
import winston from 'winston';
/* VIVENTIUM END */

const SPLAT_SYMBOL = Symbol.for('splat');
const MESSAGE_SYMBOL = Symbol.for('message');
const CONSOLE_JSON_STRING_LENGTH: number =
  parseInt(process.env.CONSOLE_JSON_STRING_LENGTH || '', 10) || 255;
const DEBUG_MESSAGE_LENGTH: number = parseInt(process.env.DEBUG_MESSAGE_LENGTH || '', 10) || 150;

// VIVENTIUM START: redact credentials at every log level, including structured debug config.
const sensitiveKeys: RegExp[] = [
  /\b(sk-)[A-Za-z0-9_-]{8,}/gi,
  /\b(ghp_)[A-Za-z0-9_]{8,}/gi,
  /\b(xoxb-)[A-Za-z0-9-]{8,}/gi,
  /\b(Bearer\s+)[^\s,;"']+/gi,
  /\b(api[-_ ]?key\s*[:=]\s*)[^\s,;"']+/gi,
  /\b((?:token|secret|password|passwd|pwd)\s*[:=]\s*)[^\s,;"']+/gi,
  /\b(key=)[^\s&#]+/gi,
  /\b(eyJ[A-Za-z0-9_-]+\.)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /(-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----)[\s\S]*?(-----END (?:[A-Z ]+ )?PRIVATE KEY-----)/g,
];
const sensitiveFieldName =
  /(?:api.?key|token|secret|password|passwd|pwd|authorization|credential)/i;

/**
 * Determines if a given value string is sensitive and returns matching regex patterns.
 *
 * @param valueStr - The value string to check.
 * @returns An array of regex patterns that match the value string.
 */
function getMatchingSensitivePatterns(valueStr: string): RegExp[] {
  if (valueStr) {
    sensitiveKeys.forEach((regex) => {
      regex.lastIndex = 0;
    });
    // Filter and return all regex patterns that match the value string
    return sensitiveKeys.filter((regex) => regex.test(valueStr));
  }
  return [];
}

/**
 * Redacts sensitive information from a console message and trims it to a specified length if provided.
 * @param str - The console message to be redacted.
 * @param trimLength - The optional length at which to trim the redacted message.
 * @returns The redacted and optionally trimmed console message.
 */
function redactMessage(str: string, trimLength?: number): string {
  if (!str) {
    return '';
  }

  const patterns = getMatchingSensitivePatterns(str);
  patterns.forEach((pattern) => {
    str = str.replace(pattern, '$1[REDACTED]');
  });

  if (trimLength !== undefined && str.length > trimLength) {
    return `${str.substring(0, trimLength)}...`;
  }

  return str;
}

function redactStructuredValue(value: unknown, key = ''): unknown {
  if (key && sensitiveFieldName.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return redactMessage(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactStructuredValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

/**
 * Redacts sensitive information from log messages at every log level.
 * Note: Intentionally mutates the object.
 * @param info - The log information object.
 * @returns The modified log information object.
 */
const redactFormat = winston.format((info: winston.Logform.TransformableInfo) => {
  if (typeof info.message === 'string') {
    info.message = redactMessage(info.message);
  }

  const symbolValue = (info as Record<string | symbol, unknown>)[MESSAGE_SYMBOL];
  if (typeof symbolValue === 'string') {
    (info as Record<string | symbol, unknown>)[MESSAGE_SYMBOL] = redactMessage(symbolValue);
  }
  return info;
});

/**
 * Truncates long strings, especially base64 image data, within log messages.
 *
 * @param value - The value to be inspected and potentially truncated.
 * @param length - The length at which to truncate the value. Default: 100.
 * @returns The truncated or original value.
 */
const truncateLongStrings = (value: unknown, length = 100): unknown => {
  if (typeof value === 'string') {
    return value.length > length ? value.substring(0, length) + '... [truncated]' : value;
  }

  return value;
};

/**
 * An array mapping function that truncates long strings (objects converted to JSON strings).
 * @param item - The item to be condensed.
 * @returns The condensed item.
 */
const condenseArray = (item: unknown): string | unknown => {
  if (typeof item === 'string') {
    return truncateLongStrings(JSON.stringify(item));
  } else if (typeof item === 'object') {
    return truncateLongStrings(JSON.stringify(item));
  }
  return item;
};

/**
 * Formats log messages for debugging purposes.
 * - Truncates long strings within log messages.
 * - Condenses arrays by truncating long strings and objects as strings within array items.
 * - Redacts sensitive information from log messages if the log level is 'error'.
 * - Converts log information object to a formatted string.
 *
 * @param options - The options for formatting log messages.
 * @returns The formatted log message.
 */
const debugTraverse = winston.format.printf(
  ({ level, message, timestamp, ...metadata }: Record<string, unknown>) => {
    if (!message) {
      return `${timestamp} ${level}`;
    }

    // Type-safe version of the CJS logic: !message?.trim || typeof message !== 'string'
    if (typeof message !== 'string' || !message.trim) {
      return `${timestamp} ${level}: ${JSON.stringify(message)}`;
    }

    const msgParts: string[] = [
      `${timestamp} ${level}: ${truncateLongStrings(message.trim(), DEBUG_MESSAGE_LENGTH)}`,
    ];

    try {
      if (level !== 'debug') {
        return msgParts[0];
      }

      if (!metadata) {
        return msgParts[0];
      }

      // Type-safe access to SPLAT_SYMBOL using bracket notation
      const metadataRecord = metadata as Record<string | symbol, unknown>;
      const splatArray = metadataRecord[SPLAT_SYMBOL];
      const rawDebugValue = Array.isArray(splatArray) ? splatArray[0] : undefined;
      const debugValue = redactStructuredValue(rawDebugValue);

      if (!debugValue) {
        return msgParts[0];
      }

      if (debugValue && Array.isArray(debugValue)) {
        msgParts.push(`\n${JSON.stringify(debugValue.map(condenseArray))}`);
        return msgParts.join('');
      }

      if (typeof debugValue !== 'object') {
        msgParts.push(` ${debugValue}`);
        return msgParts.join('');
      }

      const serialized = JSON.stringify(
        debugValue,
        (_key, value) => (typeof value === 'string' ? truncateLongStrings(value) : value),
        2,
      );
      msgParts.push(`\n${serialized}`);
      return msgParts.join('');
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      msgParts.push(`\n[LOGGER PARSING ERROR] ${errorMessage}`);
      return msgParts.join('');
    }
  },
);
// VIVENTIUM END

/**
 * Truncates long string values in JSON log objects.
 * Prevents outputting extremely long values (e.g., base64, blobs).
 */
const jsonTruncateFormat = winston.format((info: winston.Logform.TransformableInfo) => {
  const truncateLongStrings = (str: string, maxLength: number): string =>
    str.length > maxLength ? str.substring(0, maxLength) + '...' : str;

  const seen = new WeakSet<object>();

  const truncateObject = (obj: unknown): unknown => {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    // Handle circular references - now with proper object type
    if (seen.has(obj)) {
      return '[Circular]';
    }
    seen.add(obj);

    if (Array.isArray(obj)) {
      return obj.map((item) => truncateObject(item));
    }

    // We know this is an object at this point
    const objectRecord = obj as Record<string, unknown>;
    const newObj: Record<string, unknown> = {};
    Object.entries(objectRecord).forEach(([key, value]) => {
      if (typeof value === 'string') {
        newObj[key] = truncateLongStrings(value, CONSOLE_JSON_STRING_LENGTH);
      } else {
        newObj[key] = truncateObject(value);
      }
    });
    return newObj;
  };

  return truncateObject(info) as winston.Logform.TransformableInfo;
});

export { redactFormat, redactMessage, debugTraverse, jsonTruncateFormat };
