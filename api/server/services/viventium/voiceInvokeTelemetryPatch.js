/* === VIVENTIUM START ===
 * Feature: Voice invoke deep telemetry patch (runtime monkey patch for @librechat/agents).
 * Purpose:
 * - Split `process_stream -> first_delta` into concrete invoke-stage buckets for voice requests.
 * - Add nested model/network telemetry (`invoke -> completionWithRetry -> client.create`) and
 *   orchestration substep timings in `createCallModel` without behavior changes.
 * Added: 2026-03-04
 * Updated: 2026-03-04 (deep substep + nested model-call telemetry)
 * Notes:
 * - Telemetry-only (no behavior change).
 * - Logs only when a voice request_id is present in runnable config and latency logging is enabled.
 * === VIVENTIUM END === */
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const path = require('path');

const { logger } = require('@librechat/data-schemas');
const { StandardGraph } = require('@librechat/agents');

const PATCH_FLAG = Symbol.for('viventium.voice.invoke.telemetry.patch.v2');
const CONFIG_CACHE_KEY = Symbol.for('viventium.voice.invoke.telemetry.config');
const START_AT_KEY = Symbol.for('viventium.voice.invoke.telemetry.start_at');
const FETCH_PATCH_FLAG = Symbol.for('viventium.voice.invoke.telemetry.fetch.patch.v1');

const INVOKE_CONTEXT = new AsyncLocalStorage();
const AGENTS_CJS_DIR = path.dirname(require.resolve('@librechat/agents'));

const requireAgentsCjsModule = (relativePath) =>
  require(path.join(AGENTS_CJS_DIR, relativePath));

const asObject = (value) =>
  value != null && typeof value === 'object' ? value : null;

const isVoiceLatencyEnabled = () => process.env.VIVENTIUM_VOICE_LOG_LATENCY === '1';

const getRequestBody = (config) => {
  const cfg = asObject(config);
  const configurable = asObject(cfg?.configurable);
  return asObject(configurable?.requestBody);
};

const getVoiceRequestId = (config) => {
  const requestBody = getRequestBody(config);
  const requestId = requestBody?.viventiumVoiceRequestId;
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
};

const getVoiceStartAtMs = (config) => {
  const requestBody = getRequestBody(config);
  const startedAt = requestBody?.viventiumVoiceStartAtMs;
  return typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null;
};

const hashString = (value) => {
  if (typeof value !== 'string' || value.length === 0) {
    return 'none';
  }
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
};

const asUrl = (value) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const isLikelyLlmFetchTarget = (urlObj) => {
  if (!urlObj || !urlObj.hostname) {
    return false;
  }

  const host = String(urlObj.hostname).toLowerCase();
  const pathName = String(urlObj.pathname || '').toLowerCase();

  const hostAllowed =
    host.includes('x.ai') ||
    host.includes('openai') ||
    host.includes('anthropic') ||
    host.includes('generativelanguage.googleapis.com') ||
    host.includes('openrouter.ai') ||
    host.includes('cohere.ai') ||
    host.includes('azure.com') ||
    host.includes('azure.net');

  if (!hostAllowed) {
    return false;
  }

  return (
    pathName.includes('/chat/completions') ||
    pathName.includes('/responses') ||
    pathName.includes('/messages') ||
    pathName.includes('/completions') ||
    pathName.includes('streamgeneratecontent') ||
    pathName.includes('generatecontent')
  );
};

const summarizeToolNames = (tools) => {
  if (!Array.isArray(tools) || tools.length === 0) {
    return {
      count: 0,
      sample: 'none',
      hash: 'none',
    };
  }

  const names = tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') {
        return '';
      }
      if (typeof tool.name === 'string') {
        return tool.name;
      }
      if (tool.function && typeof tool.function?.name === 'string') {
        return tool.function.name;
      }
      if (tool.lc_kwargs && typeof tool.lc_kwargs?.name === 'string') {
        return tool.lc_kwargs.name;
      }
      return '';
    })
    .filter((name) => name.length > 0);

  const sample = names.slice(0, 10).join(',') || 'none';
  const joined = names.join('|');
  return {
    count: names.length,
    sample,
    hash: hashString(joined),
  };
};

const estimateMessageContentChars = (messages) => {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let chars = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') {
      chars += content.length;
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      if (typeof part.text === 'string') {
        chars += part.text.length;
      } else if (part.text && typeof part.text?.value === 'string') {
        chars += part.text.value.length;
      } else if (typeof part.reasoning_content === 'string') {
        chars += part.reasoning_content.length;
      } else if (typeof part.reasoning === 'string') {
        chars += part.reasoning.length;
      } else if (typeof part.output === 'string') {
        chars += part.output.length;
      }
    }
  }
  return chars;
};

const estimateResultShape = (result) => {
  const resultMessages = Array.isArray(result?.messages) ? result.messages : [];
  const firstMessage = resultMessages[0];
  const toolCalls = Array.isArray(firstMessage?.tool_calls) ? firstMessage.tool_calls.length : 0;
  let contentChars = 0;
  if (typeof firstMessage?.content === 'string') {
    contentChars = firstMessage.content.length;
  } else if (Array.isArray(firstMessage?.content)) {
    for (const part of firstMessage.content) {
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        contentChars += part.text.length;
      }
    }
  }
  return {
    resultMessages: resultMessages.length,
    toolCalls,
    contentChars,
  };
};

const getInvokeContext = () => {
  const ctx = INVOKE_CONTEXT.getStore();
  return ctx && typeof ctx === 'object' ? ctx : null;
};

const getContextConfig = (config) => {
  if (config) {
    return config;
  }
  const ctx = getInvokeContext();
  return ctx?.config ?? null;
};

const nextStageOrdinal = () => {
  const ctx = getInvokeContext();
  if (!ctx) {
    return 0;
  }
  const next = (ctx.stageOrdinal || 0) + 1;
  ctx.stageOrdinal = next;
  return next;
};

const logInvokeStage = ({ config = null, stage, stageStartAt = null, details = '' }) => {
  if (!isVoiceLatencyEnabled()) {
    return;
  }

  const resolvedConfig = getContextConfig(config);
  const requestId = getVoiceRequestId(resolvedConfig);
  if (!requestId) {
    return;
  }

  const now = Date.now();
  const stageMs = typeof stageStartAt === 'number' ? now - stageStartAt : null;
  const routeStartAt = getVoiceStartAtMs(resolvedConfig);
  const totalPart =
    routeStartAt != null && Number.isFinite(routeStartAt) ? ` total_ms=${now - routeStartAt}` : '';
  const stagePart = stageMs == null ? '' : ` stage_ms=${stageMs}`;
  const ord = nextStageOrdinal();
  const ordPart = ord > 0 ? ` ord=${ord}` : '';
  const detailPart = details ? ` ${details}` : '';
  logger.info(
    `[VoiceLatency][LC][Invoke] request_id=${requestId} stage=${stage}${totalPart}${stagePart}${ordPart}${detailPart}`,
  );
};

const installFetchTelemetryPatch = () => {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function') {
    return false;
  }
  if (originalFetch[FETCH_PATCH_FLAG] === true) {
    return false;
  }

  const wrappedFetch = async function viventiumInvokeTelemetryFetch(input, init) {
    const ctx = getInvokeContext();
    if (!ctx || !isVoiceLatencyEnabled()) {
      return originalFetch.call(this, input, init);
    }

    const urlValue =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object' && typeof input.url === 'string'
          ? input.url
          : null;

    const urlObj = asUrl(urlValue);
    if (!isLikelyLlmFetchTarget(urlObj)) {
      return originalFetch.call(this, input, init);
    }

    const method =
      (init && typeof init === 'object' && typeof init.method === 'string' ? init.method : null) ||
      (input && typeof input === 'object' && typeof input.method === 'string' ? input.method : null) ||
      'GET';
    const host = String(urlObj.hostname || '').toLowerCase();
    const endpoint = String(urlObj.pathname || '');
    const detailBase = `method=${method.toUpperCase()} host=${host} endpoint=${endpoint}`;
    const startedAt = Date.now();

    logInvokeStage({
      config: ctx.config,
      stage: 'provider_fetch_start',
      details: detailBase,
    });

    try {
      const response = await originalFetch.call(this, input, init);
      logInvokeStage({
        config: ctx.config,
        stage: 'provider_fetch_headers',
        stageStartAt: startedAt,
        details: `${detailBase} status=${response?.status ?? 'unknown'}`,
      });
      return response;
    } catch (error) {
      const message = error?.message ? String(error.message).replace(/\s+/g, '_') : 'unknown';
      logInvokeStage({
        config: ctx.config,
        stage: 'provider_fetch_error',
        stageStartAt: startedAt,
        details: `${detailBase} reason=${message}`,
      });
      throw error;
    }
  };

  Object.defineProperty(wrappedFetch, FETCH_PATCH_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  globalThis.fetch = wrappedFetch;
  return true;
};

const installTimedModuleFunctionPatch = ({ moduleObj, fnName, stage, wrapResult = null, details = null }) => {
  if (!moduleObj || typeof moduleObj !== 'object') {
    return false;
  }
  const original = moduleObj[fnName];
  if (typeof original !== 'function') {
    return false;
  }
  const guardKey = `__viventiumVoiceTimed__${fnName}`;
  if (original[guardKey] === true) {
    return false;
  }

  const patched = function patchedTimedFunction(...args) {
    const ctx = getInvokeContext();
    if (!ctx) {
      return original.apply(this, args);
    }

    const startedAt = Date.now();
    try {
      const out = original.apply(this, args);
      if (out && typeof out.then === 'function') {
        return out
          .then((resolved) => {
            const detail = typeof details === 'function' ? details(args, resolved) : details;
            logInvokeStage({
              config: ctx.config,
              stage,
              stageStartAt: startedAt,
              details: detail || '',
            });
            if (typeof wrapResult === 'function') {
              return wrapResult({ args, result: resolved, ctx, stage });
            }
            return resolved;
          })
          .catch((error) => {
            const message = error?.message ? String(error.message).replace(/\s+/g, '_') : 'unknown';
            logInvokeStage({
              config: ctx.config,
              stage: `${stage}_error`,
              stageStartAt: startedAt,
              details: `reason=${message}`,
            });
            throw error;
          });
      }

      const detail = typeof details === 'function' ? details(args, out) : details;
      logInvokeStage({
        config: ctx.config,
        stage,
        stageStartAt: startedAt,
        details: detail || '',
      });

      if (typeof wrapResult === 'function') {
        return wrapResult({ args, result: out, ctx, stage });
      }
      return out;
    } catch (error) {
      const message = error?.message ? String(error.message).replace(/\s+/g, '_') : 'unknown';
      logInvokeStage({
        config: ctx.config,
        stage: `${stage}_error`,
        stageStartAt: startedAt,
        details: `reason=${message}`,
      });
      throw error;
    }
  };

  Object.defineProperty(patched, guardKey, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  moduleObj[fnName] = patched;
  return true;
};

const installCreateCallModelPatch = (proto) => {
  if (typeof proto.createCallModel !== 'function') {
    return;
  }

  const originalCreateCallModel = proto.createCallModel;
  proto.createCallModel = function patchedCreateCallModel(agentId = 'default') {
    const originalCallModel = originalCreateCallModel.call(this, agentId);
    if (typeof originalCallModel !== 'function') {
      return originalCallModel;
    }

    return async (state, config) => {
      const requestId = getVoiceRequestId(config);
      if (!requestId) {
        return originalCallModel(state, config);
      }

      const startedAt = Date.now();
      this[CONFIG_CACHE_KEY] = config;
      this[START_AT_KEY] = startedAt;

      const agentContext = this?.agentContexts?.get?.(agentId);
      const toolNames = summarizeToolNames(agentContext?.tools);
      const discoveredCount = agentContext?.discoveredToolNames?.size ?? 0;
      const messageCount = Array.isArray(state?.messages) ? state.messages.length : 0;
      const messageChars = estimateMessageContentChars(state?.messages);

      logInvokeStage({
        config,
        stage: 'call_model_enter',
        details:
          `agent_id=${agentId} messages=${messageCount} message_chars=${messageChars} ` +
          `tools=${toolNames.count} discovered_tools=${discoveredCount} ` +
          `tool_sample=${toolNames.sample} tool_hash=${toolNames.hash}`,
      });

      const context = {
        config,
        requestId,
        agentId,
        callStartedAt: startedAt,
        stageOrdinal: 0,
        invokeAttempts: 0,
      };

      try {
        const result = await INVOKE_CONTEXT.run(context, () => originalCallModel(state, config));
        const summary = estimateResultShape(result);
        logInvokeStage({
          config,
          stage: 'call_model_done',
          stageStartAt: startedAt,
          details:
            `agent_id=${agentId} result_messages=${summary.resultMessages} ` +
            `result_tool_calls=${summary.toolCalls} result_content_chars=${summary.contentChars}`,
        });
        return result;
      } catch (error) {
        const message = error?.message ? String(error.message).replace(/\s+/g, '_') : 'unknown';
        logInvokeStage({
          config,
          stage: 'call_model_error',
          stageStartAt: startedAt,
          details: `agent_id=${agentId} reason=${message}`,
        });
        throw error;
      } finally {
        this[CONFIG_CACHE_KEY] = null;
      }
    };
  };
};

const installInitializeModelPatch = (proto) => {
  if (typeof proto.initializeModel !== 'function') {
    return;
  }

  const originalInitializeModel = proto.initializeModel;
  proto.initializeModel = function patchedInitializeModel(params) {
    const config = this?.[CONFIG_CACHE_KEY] ?? null;
    const startedAt = Date.now();
    const provider = params?.provider || 'unknown';
    const toolsCount = Array.isArray(params?.tools) ? params.tools.length : 0;
    logInvokeStage({
      config,
      stage: 'initialize_model_start',
      details: `provider=${provider} tools=${toolsCount}`,
    });
    try {
      const model = originalInitializeModel.call(this, params);
      logInvokeStage({
        config,
        stage: 'initialize_model_done',
        stageStartAt: startedAt,
        details: `provider=${provider} tools=${toolsCount} model_class=${model?.constructor?.name || 'unknown'}`,
      });
      return model;
    } catch (error) {
      const message = error?.message ? String(error.message).replace(/\s+/g, '_') : 'unknown';
      logInvokeStage({
        config,
        stage: 'initialize_model_error',
        stageStartAt: startedAt,
        details: `provider=${provider} reason=${message}`,
      });
      throw error;
    }
  };
};

const installPerInvokeModelTelemetry = ({ model, config, provider, toolsCount }) => {
  if (!model || typeof model !== 'object') {
    return () => {};
  }

  const restoreFns = [];

  const installMethodTimer = ({ target, key, stageStart, stageDone, detailPrefix = '' }) => {
    if (!target || typeof target !== 'object') {
      return;
    }
    const original = target[key];
    if (typeof original !== 'function') {
      return;
    }

    const guardKey = Symbol.for(`viventium.voice.invoke.telemetry.${key}`);
    if (original[guardKey] === true) {
      return;
    }

    const wrapped = async function timedWrappedMethod(...args) {
      const startedAt = Date.now();
      const streamFlag = asObject(args?.[0])?.stream;
      const streamPart = typeof streamFlag === 'boolean' ? ` stream=${streamFlag}` : '';
      const details = `${detailPrefix}${detailPrefix ? ' ' : ''}provider=${provider} tools=${toolsCount}${streamPart}`;

      logInvokeStage({
        config,
        stage: stageStart,
        details,
      });

      try {
        const result = await original.apply(this, args);

        if (result && typeof result[Symbol.asyncIterator] === 'function') {
          const iterable = result;
          const firstChunkState = { seen: false };

          const wrappedIterable = {
            async *[Symbol.asyncIterator]() {
              let chunkCount = 0;
              for await (const chunk of iterable) {
                chunkCount += 1;
                if (!firstChunkState.seen) {
                  firstChunkState.seen = true;
                  logInvokeStage({
                    config,
                    stage: `${stageDone}_first_chunk`,
                    stageStartAt: startedAt,
                    details,
                  });
                }
                yield chunk;
              }
              logInvokeStage({
                config,
                stage: `${stageDone}_stream_done`,
                stageStartAt: startedAt,
                details: `${details} chunks=${chunkCount}`,
              });
            },
          };

          return wrappedIterable;
        }

        let responseShape = '';
        if (result && typeof result === 'object') {
          const choicesLen = Array.isArray(result?.choices) ? result.choices.length : null;
          const usageTotal = result?.usage?.total_tokens;
          if (choicesLen != null) {
            responseShape += ` choices=${choicesLen}`;
          }
          if (Number.isFinite(usageTotal)) {
            responseShape += ` total_tokens=${usageTotal}`;
          }
        }

        logInvokeStage({
          config,
          stage: stageDone,
          stageStartAt: startedAt,
          details: `${details}${responseShape}`,
        });
        return result;
      } catch (error) {
        const message = error?.message ? String(error.message).replace(/\s+/g, '_') : 'unknown';
        logInvokeStage({
          config,
          stage: `${stageDone}_error`,
          stageStartAt: startedAt,
          details: `${details} reason=${message}`,
        });
        throw error;
      }
    };

    Object.defineProperty(wrapped, guardKey, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    target[key] = wrapped;
    restoreFns.push(() => {
      target[key] = original;
    });
  };

  installMethodTimer({
    target: model,
    key: 'invoke',
    stageStart: 'model_invoke_start',
    stageDone: 'model_invoke_done',
    detailPrefix: `model_class=${model?.constructor?.name || 'unknown'}`,
  });

  installMethodTimer({
    target: model,
    key: 'completionWithRetry',
    stageStart: 'model_completion_with_retry_start',
    stageDone: 'model_completion_with_retry_done',
    detailPrefix: `model_class=${model?.constructor?.name || 'unknown'}`,
  });

  installMethodTimer({
    target: model,
    key: 'responseApiWithRetry',
    stageStart: 'model_response_api_with_retry_start',
    stageDone: 'model_response_api_with_retry_done',
    detailPrefix: `model_class=${model?.constructor?.name || 'unknown'}`,
  });

  const client = model?.exposedClient ?? null;
  const clientLabel = client?.constructor?.name || 'unknown_client';

  if (client?.chat?.completions && typeof client.chat.completions.create === 'function') {
    installMethodTimer({
      target: client.chat.completions,
      key: 'create',
      stageStart: 'model_client_chat_create_start',
      stageDone: 'model_client_chat_create_done',
      detailPrefix: `client=${clientLabel}`,
    });
  }

  if (client?.responses && typeof client.responses.create === 'function') {
    installMethodTimer({
      target: client.responses,
      key: 'create',
      stageStart: 'model_client_responses_create_start',
      stageDone: 'model_client_responses_create_done',
      detailPrefix: `client=${clientLabel}`,
    });
  }

  return () => {
    while (restoreFns.length > 0) {
      const fn = restoreFns.pop();
      try {
        fn?.();
      } catch {
        // no-op
      }
    }
  };
};

const installAttemptInvokePatch = (proto) => {
  if (typeof proto.attemptInvoke !== 'function') {
    return;
  }

  const originalAttemptInvoke = proto.attemptInvoke;
  proto.attemptInvoke = async function patchedAttemptInvoke(args, config) {
    const startedAt = Date.now();
    const provider = args?.provider || 'unknown';
    const toolsCount = Array.isArray(args?.tools) ? args.tools.length : 0;
    const messageCount = Array.isArray(args?.finalMessages) ? args.finalMessages.length : 0;
    const messageChars = estimateMessageContentChars(args?.finalMessages);

    const context = getInvokeContext();
    if (context) {
      context.invokeAttempts = (context.invokeAttempts || 0) + 1;
    }
    const attempt = context?.invokeAttempts || 1;

    logInvokeStage({
      config,
      stage: 'attempt_invoke_start',
      details:
        `provider=${provider} tools=${toolsCount} final_messages=${messageCount} ` +
        `final_message_chars=${messageChars} attempt=${attempt}`,
    });

    const model = this?.overrideModel ?? args?.currentModel;
    const restoreModelTelemetry = installPerInvokeModelTelemetry({
      model,
      config,
      provider,
      toolsCount,
    });

    try {
      const result = await originalAttemptInvoke.call(this, args, config);
      const summary = estimateResultShape(result);
      logInvokeStage({
        config,
        stage: 'attempt_invoke_done',
        stageStartAt: startedAt,
        details:
          `provider=${provider} tools=${toolsCount} attempt=${attempt} ` +
          `result_messages=${summary.resultMessages} result_tool_calls=${summary.toolCalls} ` +
          `result_content_chars=${summary.contentChars}`,
      });
      return result;
    } catch (error) {
      const message = error?.message ? String(error.message).replace(/\s+/g, '_') : 'unknown';
      logInvokeStage({
        config,
        stage: 'attempt_invoke_error',
        stageStartAt: startedAt,
        details: `provider=${provider} attempt=${attempt} reason=${message}`,
      });
      throw error;
    } finally {
      restoreModelTelemetry();
    }
  };
};

const installCreateCallModelSubstepPatches = () => {
  const toolModule = requireAgentsCjsModule('messages/tools.cjs');
  const pruneModule = requireAgentsCjsModule('messages/prune.cjs');
  const formatModule = requireAgentsCjsModule('messages/format.cjs');
  const coreModule = requireAgentsCjsModule('messages/core.cjs');
  const cacheModule = requireAgentsCjsModule('messages/cache.cjs');
  const contentModule = requireAgentsCjsModule('messages/content.cjs');
  const runModule = requireAgentsCjsModule('utils/run.cjs');

  installTimedModuleFunctionPatch({
    moduleObj: toolModule,
    fnName: 'extractToolDiscoveries',
    stage: 'sub_extract_tool_discoveries',
    details: (_args, result) => {
      const count = Array.isArray(result) ? result.length : 0;
      const sample = Array.isArray(result) ? result.slice(0, 10).join(',') || 'none' : 'none';
      return `discovered_count=${count} discovered_sample=${sample}`;
    },
  });

  installTimedModuleFunctionPatch({
    moduleObj: pruneModule,
    fnName: 'createPruneMessages',
    stage: 'sub_create_prune_messages',
    details: (args) => {
      const options = asObject(args?.[0]);
      return [
        `provider=${options?.provider || 'unknown'}`,
        `start_index=${Number.isFinite(options?.startIndex) ? options.startIndex : 'na'}`,
        `max_tokens=${Number.isFinite(options?.maxTokens) ? options.maxTokens : 'na'}`,
        `thinking_enabled=${options?.thinkingEnabled === true}`,
      ].join(' ');
    },
    wrapResult: ({ result, ctx }) => {
      if (typeof result !== 'function') {
        return result;
      }

      const pruneFn = result;
      return function patchedPruneMessages(...pruneArgs) {
        const pruneStart = Date.now();
        const input = asObject(pruneArgs?.[0]);
        const inputMessages = Array.isArray(input?.messages) ? input.messages.length : 0;

        const output = pruneFn.apply(this, pruneArgs);

        const emit = (resolvedOutput) => {
          const out = asObject(resolvedOutput);
          const outMessages = Array.isArray(out?.context) ? out.context.length : 0;
          const map = asObject(out?.indexTokenCountMap);
          const mapKeys = map ? Object.keys(map).length : 0;
          logInvokeStage({
            config: ctx.config,
            stage: 'sub_apply_prune_messages',
            stageStartAt: pruneStart,
            details: `input_messages=${inputMessages} output_messages=${outMessages} token_map_keys=${mapKeys}`,
          });
        };

        if (output && typeof output.then === 'function') {
          return output.then((resolved) => {
            emit(resolved);
            return resolved;
          });
        }

        emit(output);
        return output;
      };
    },
  });

  installTimedModuleFunctionPatch({
    moduleObj: contentModule,
    fnName: 'formatContentStrings',
    stage: 'sub_format_content_strings',
    details: (args, result) => {
      const before = Array.isArray(args?.[0]) ? args[0].length : 0;
      const after = Array.isArray(result) ? result.length : 0;
      return `messages_before=${before} messages_after=${after}`;
    },
  });

  installTimedModuleFunctionPatch({
    moduleObj: coreModule,
    fnName: 'formatAnthropicArtifactContent',
    stage: 'sub_format_anthropic_artifact_content',
    details: (args) => {
      const messages = Array.isArray(args?.[0]) ? args[0].length : 0;
      return `messages=${messages}`;
    },
  });

  installTimedModuleFunctionPatch({
    moduleObj: coreModule,
    fnName: 'formatArtifactPayload',
    stage: 'sub_format_artifact_payload',
    details: (args) => {
      const messages = Array.isArray(args?.[0]) ? args[0].length : 0;
      return `messages=${messages}`;
    },
  });

  installTimedModuleFunctionPatch({
    moduleObj: cacheModule,
    fnName: 'addCacheControl',
    stage: 'sub_add_cache_control',
    details: (args, result) => {
      const before = Array.isArray(args?.[0]) ? args[0].length : 0;
      const after = Array.isArray(result) ? result.length : 0;
      return `messages_before=${before} messages_after=${after}`;
    },
  });

  installTimedModuleFunctionPatch({
    moduleObj: cacheModule,
    fnName: 'addBedrockCacheControl',
    stage: 'sub_add_bedrock_cache_control',
    details: (args, result) => {
      const before = Array.isArray(args?.[0]) ? args[0].length : 0;
      const after = Array.isArray(result) ? result.length : 0;
      return `messages_before=${before} messages_after=${after}`;
    },
  });

  installTimedModuleFunctionPatch({
    moduleObj: formatModule,
    fnName: 'ensureThinkingBlockInMessages',
    stage: 'sub_ensure_thinking_block',
    details: (args, result) => {
      const before = Array.isArray(args?.[0]) ? args[0].length : 0;
      const after = Array.isArray(result) ? result.length : 0;
      const provider = args?.[1] || 'unknown';
      return `provider=${provider} messages_before=${before} messages_after=${after}`;
    },
  });

  installTimedModuleFunctionPatch({
    moduleObj: runModule,
    fnName: 'sleep',
    stage: 'sub_stream_buffer_sleep',
    details: (args) => {
      const requested = Number.isFinite(args?.[0]) ? args[0] : 0;
      return `requested_ms=${requested}`;
    },
  });
};

const applyVoiceInvokeTelemetryPatch = () => {
  if (!isVoiceLatencyEnabled()) {
    return false;
  }

  const proto = StandardGraph?.prototype;
  if (!proto || proto[PATCH_FLAG] === true) {
    return false;
  }

  installCreateCallModelSubstepPatches();
  installFetchTelemetryPatch();
  installCreateCallModelPatch(proto);
  installInitializeModelPatch(proto);
  installAttemptInvokePatch(proto);

  Object.defineProperty(proto, PATCH_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  logger.info('[VoiceLatency][LC][Invoke] runtime patch applied (deep)');
  return true;
};

module.exports = {
  applyVoiceInvokeTelemetryPatch,
};
