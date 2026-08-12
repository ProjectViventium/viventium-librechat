/* === VIVENTIUM START ===
 * Feature: Agent schema-tool binding consistency patch.
 * Purpose:
 * - @librechat/agents builds a unified `toolsForBinding` list from event-driven
 *   tool definitions, graph tools, and bound tools, then binds that list to the
 *   primary model.
 * - The same graph still passes `agentContext.tools` into invoke telemetry and
 *   fallback model binding. In event-driven schema-only mode, `agentContext.tools`
 *   can be empty while recall/MCP schemas are present in `toolsForBinding`, which
 *   makes diagnostics report `tools=0` and drops schema-only tools on fallback.
 * - For the duration of one async model invocation, expose the already-computed
 *   unified list through `agentContext.tools` so fallback binding uses the same
 *   tool set without mutating shared state seen by overlapping requests.
 * Added: 2026-06-25
 * === VIVENTIUM END === */
'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { SystemMessage } = require('@langchain/core/messages');
const { logger } = require('@librechat/data-schemas');
const { StandardGraph } = require('@librechat/agents');
const { isRecoverableProviderFallbackError } = require('./agentLlmFallback');

const PATCH_FLAG = Symbol.for('viventium.agent.schema.tool.binding.patch.v7');
const SCOPED_TOOLS_FLAG = Symbol.for('viventium.agent.schema.tool.binding.accessor.v1');
const DEDUPED_BINDING_FLAG = Symbol.for('viventium.agent.schema.tool.binding.dedupe.v1');
const SCOPED_BINDING_FLAG = Symbol.for('viventium.agent.schema.tool.binding.method.v1');
const SCOPED_FALLBACK_ROUTE_FLAG = Symbol.for('viventium.agent.graph.fallback.route.accessor.v1');
const GRAPH_FALLBACK_CONTEXT = Symbol.for('viventium.agent.graph.fallback.runtime.context.v1');
const MODEL_ROUTE_CAPABILITY_REFRESH = Symbol.for(
  'viventium.agent.model.route.capability.refresh.v1',
);
const scopedTools = new AsyncLocalStorage();
const fallbackInvocationPolicy = new AsyncLocalStorage();

function dedupeToolsByName(tools) {
  if (!Array.isArray(tools) || tools.length < 2) {
    return tools;
  }
  const seenNames = new Set();
  let duplicateFound = false;
  const deduped = tools.filter((tool) => {
    const name = toolName(tool);
    if (!name) {
      return true;
    }
    if (seenNames.has(name)) {
      duplicateFound = true;
      return false;
    }
    seenNames.add(name);
    return true;
  });
  return duplicateFound ? deduped : tools;
}

function installDedupedBindingMethod(agentContext) {
  if (agentContext?.[DEDUPED_BINDING_FLAG] === true) {
    return true;
  }
  if (!agentContext || typeof agentContext.getToolsForBinding !== 'function') {
    return false;
  }
  const originalGetToolsForBinding = agentContext.getToolsForBinding;
  agentContext.getToolsForBinding = function getDedupedToolsForBinding(...args) {
    return dedupeToolsByName(originalGetToolsForBinding.apply(this, args));
  };
  Object.defineProperty(agentContext, DEDUPED_BINDING_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return true;
}

function installScopedToolsAccessor(agentContext) {
  if (agentContext?.[SCOPED_TOOLS_FLAG] === true) {
    return true;
  }
  const descriptor = Object.getOwnPropertyDescriptor(agentContext, 'tools');
  if (descriptor?.configurable === false) {
    return false;
  }

  let baseTools = agentContext.tools;
  let resolvingScopedValue = false;
  const currentGetToolsForBinding = agentContext.getToolsForBinding;
  if (
    typeof currentGetToolsForBinding === 'function' &&
    currentGetToolsForBinding[SCOPED_BINDING_FLAG] !== true
  ) {
    const scopedGetToolsForBinding = function scopedGetToolsForBinding(...args) {
      const scopedEntry = scopedTools.getStore()?.get(agentContext);
      if (!scopedEntry) {
        return currentGetToolsForBinding.apply(this, args);
      }
      scopedEntry.computingBinding = true;
      try {
        return currentGetToolsForBinding.apply(this, args);
      } finally {
        scopedEntry.computingBinding = false;
      }
    };
    Object.defineProperty(scopedGetToolsForBinding, SCOPED_BINDING_FLAG, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(agentContext, 'getToolsForBinding', {
      value: scopedGetToolsForBinding,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(agentContext, 'tools', {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get() {
      const scopedEntry = scopedTools.getStore()?.get(agentContext);
      if (!scopedEntry || scopedEntry.computingBinding === true) {
        return baseTools;
      }
      const scopedValue = scopedEntry.value;
      if (typeof scopedValue !== 'function') {
        return scopedValue;
      }
      if (resolvingScopedValue) {
        return baseTools;
      }
      // getToolsForBinding is synchronous. This guard only breaks its immediate
      // `this.tools` re-entry; it must never span an await boundary.
      resolvingScopedValue = true;
      try {
        return scopedValue();
      } finally {
        resolvingScopedValue = false;
      }
    },
    set(value) {
      baseTools = value;
    },
  });
  Object.defineProperty(agentContext, SCOPED_TOOLS_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return true;
}

function toolName(tool) {
  if (!tool || typeof tool !== 'object') {
    return '';
  }
  if (typeof tool.name === 'string') {
    return tool.name;
  }
  if (tool.function && typeof tool.function.name === 'string') {
    return tool.function.name;
  }
  if (tool.lc_kwargs && typeof tool.lc_kwargs.name === 'string') {
    return tool.lc_kwargs.name;
  }
  return '';
}

function sameToolList(left, right) {
  if (left === right) {
    return true;
  }
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every(
    (tool, index) => tool === right[index] || toolName(tool) === toolName(right[index]),
  );
}

function summarizeTools(tools) {
  const names = Array.isArray(tools)
    ? tools.map(toolName).filter((name) => typeof name === 'string' && name.length > 0)
    : [];
  return {
    count: names.length,
    hasFileSearch: names.includes('file_search'),
    sample: names.slice(0, 8).join(',') || 'none',
  };
}

function createGraphAbortError() {
  const error = new Error('operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function installScopedFallbackRouteAccessors(agentContext) {
  if (agentContext?.[SCOPED_FALLBACK_ROUTE_FLAG] === true) {
    return true;
  }
  if (!agentContext || typeof agentContext !== 'object') {
    return false;
  }
  for (const field of ['provider', 'reasoningKey', 'clientOptions', 'systemRunnable']) {
    const descriptor = Object.getOwnPropertyDescriptor(agentContext, field);
    if (descriptor?.configurable === false) {
      return false;
    }
    let baseValue = agentContext[field];
    Object.defineProperty(agentContext, field, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get() {
        const activeRoute = fallbackInvocationPolicy.getStore()?.activeRoute;
        return activeRoute && Object.prototype.hasOwnProperty.call(activeRoute, field)
          ? activeRoute[field]
          : baseValue;
      },
      set(value) {
        baseValue = value;
      },
    });
  }
  Object.defineProperty(agentContext, SCOPED_FALLBACK_ROUTE_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return true;
}

function systemMessageText(message) {
  if (!message) {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return '';
  }
  return message.content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }
      return typeof part.text === 'string' ? part.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function appendFallbackSystemInstructions(messages, instructions) {
  const append = String(instructions || '').trim();
  if (!append) {
    return messages;
  }
  const nextMessages = Array.isArray(messages) ? [...messages] : [];
  const systemIndex = nextMessages.findIndex(
    (message) => typeof message?.getType === 'function' && message.getType() === 'system',
  );
  if (systemIndex < 0) {
    return [new SystemMessage(append), ...nextMessages];
  }
  const currentText = systemMessageText(nextMessages[systemIndex]);
  if (currentText.includes(append)) {
    return nextMessages;
  }
  nextMessages[systemIndex] = new SystemMessage([currentText, append].filter(Boolean).join('\n\n'));
  return nextMessages;
}

function replaceCapabilitySystemInstructions(
  messages,
  { previousInstructionAppend = '', instructionAppend = '' } = {},
) {
  const previous = String(previousInstructionAppend || '').trim();
  const next = String(instructionAppend || '').trim();
  if (!previous && !next) {
    return messages;
  }
  const nextMessages = Array.isArray(messages) ? [...messages] : [];
  const systemIndex = nextMessages.findIndex(
    (message) => typeof message?.getType === 'function' && message.getType() === 'system',
  );
  if (systemIndex < 0) {
    return next ? [new SystemMessage(next), ...nextMessages] : nextMessages;
  }
  let currentText = systemMessageText(nextMessages[systemIndex]);
  if (previous && currentText.includes(previous)) {
    currentText = currentText
      .replace(previous, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (next && !currentText.includes(next)) {
    currentText = [currentText, next].filter(Boolean).join('\n\n');
  }
  nextMessages[systemIndex] = new SystemMessage(currentText);
  return nextMessages;
}

async function prepareFallbackInvocationInput(input, config, policy) {
  const agentContext = policy?.agentContext;
  let finalMessages = input?.finalMessages;
  const baseSystemRunnable = policy?.baseSystemRunnable || agentContext?.systemRunnable;
  if (baseSystemRunnable && typeof baseSystemRunnable.invoke === 'function') {
    finalMessages = await baseSystemRunnable.invoke(finalMessages, config);
  }
  const refreshResult = policy?.activeCapabilityRefreshResult;
  if (refreshResult) {
    finalMessages = replaceCapabilitySystemInstructions(finalMessages, {
      previousInstructionAppend:
        refreshResult.previousInstructionAppend ||
        policy?.activeFallbackContext?.systemInstructionAppend,
      instructionAppend:
        refreshResult.instructionAppend ?? policy?.activeFallbackContext?.systemInstructionAppend,
    });
  } else {
    finalMessages = appendFallbackSystemInstructions(
      finalMessages,
      policy?.activeFallbackContext?.systemInstructionAppend,
    );
  }
  return { ...input, finalMessages };
}

function preparePrimaryInvocationInput(input, policy) {
  const refreshResult = policy?.activeCapabilityRefreshResult;
  if (!refreshResult) {
    return input;
  }
  return {
    ...input,
    finalMessages: replaceCapabilitySystemInstructions(input?.finalMessages, refreshResult),
  };
}

async function refreshCapabilityForAttempt(policy, attemptIndex) {
  const refresh =
    attemptIndex === 0
      ? policy?.agentContext?.clientOptions?.[MODEL_ROUTE_CAPABILITY_REFRESH]
      : policy?.activeCapabilityRefresh;
  if (typeof refresh !== 'function') {
    if (policy) {
      policy.activeCapabilityRefreshResult = null;
    }
    return;
  }
  const refreshed = await refresh();
  policy.activeCapabilityRefreshResult = refreshed;
  if (attemptIndex > 0 && refreshed && typeof refreshed === 'object') {
    policy.activeFallbackInstructionAppend = String(
      refreshed.instructionAppend ?? policy?.activeFallbackContext?.systemInstructionAppend ?? '',
    ).trim();
  }
}

function authoringEvidenceSnapshot(graph) {
  return {
    runStepCount: Array.isArray(graph?.contentData) ? graph.contentData.length : 0,
    toolCallCount: graph?.toolCallStepIds instanceof Map ? graph.toolCallStepIds.size : 0,
  };
}

function hasNewAuthoringEvidence(graph, before) {
  const after = authoringEvidenceSnapshot(graph);
  return after.runStepCount > before.runStepCount || after.toolCallCount > before.toolCallCount;
}

function recordGraphFallbackRecovery(graph, fallbackContext) {
  if (!graph || graph.viventiumGraphFallbackRecoveryReceipt || !fallbackContext) {
    return;
  }
  Object.defineProperty(graph, 'viventiumGraphFallbackRecoveryReceipt', {
    value: Object.freeze({
      provider: String(fallbackContext.provider || '').trim(),
      model: String(fallbackContext.model || '').trim(),
    }),
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

function cloneClientOptionsWithoutFallbacks(clientOptions) {
  const clone = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(
      clientOptions && typeof clientOptions === 'object' ? clientOptions : {},
    ),
  );
  clone.fallbacks = [];
  return clone;
}

function fallbackRuntimeContext(fallback) {
  const clientOptions = fallback?.clientOptions || {};
  const declared = clientOptions[GRAPH_FALLBACK_CONTEXT];
  if (declared && typeof declared === 'object') {
    return declared;
  }
  return Object.freeze({
    provider: fallback?.provider,
    model: String(clientOptions.model || clientOptions.modelName || '').trim(),
    reasoningKey: undefined,
    systemInstructionAppend: '',
  });
}

async function invokeModernFallbackPolicy({
  graph,
  agentContext,
  originalCallModel,
  state,
  config,
  policy,
}) {
  if (config?.signal?.aborted === true) {
    throw createGraphAbortError();
  }
  const baseClientOptions = policy.baseClientOptions || {};
  const fallbacks = Array.isArray(baseClientOptions.fallbacks)
    ? [...baseClientOptions.fallbacks]
    : [];
  policy.activeRoute = {
    provider: policy.baseProvider,
    reasoningKey: policy.baseReasoningKey,
    clientOptions: cloneClientOptionsWithoutFallbacks(baseClientOptions),
    systemRunnable: policy.baseSystemRunnable,
  };
  await refreshCapabilityForAttempt(policy, 0);
  if (config?.signal?.aborted === true) {
    throw createGraphAbortError();
  }
  let primaryState = state;
  let primaryMessages = state?.messages;
  if (policy.baseSystemRunnable && typeof policy.baseSystemRunnable.invoke === 'function') {
    primaryMessages = await policy.baseSystemRunnable.invoke(primaryMessages, config);
    policy.activeRoute.systemRunnable = null;
  }
  const primaryInput = preparePrimaryInvocationInput({ finalMessages: primaryMessages }, policy);
  primaryState = { ...state, messages: primaryInput.finalMessages };
  const primaryAuthoringBefore = authoringEvidenceSnapshot(graph);
  try {
    return await originalCallModel(primaryState, config);
  } catch (primaryError) {
    if (
      config?.signal?.aborted === true ||
      hasNewAuthoringEvidence(graph, primaryAuthoringBefore) ||
      !isRecoverableProviderFallbackError(primaryError)
    ) {
      throw config?.signal?.aborted === true ? createGraphAbortError() : primaryError;
    }

    let lastError = primaryError;
    for (let index = 0; index < fallbacks.length; index += 1) {
      if (config?.signal?.aborted === true) {
        throw createGraphAbortError();
      }
      const fallback = fallbacks[index];
      const clientOptions = fallback?.clientOptions || {};
      const runtimeContext = fallbackRuntimeContext(fallback);
      policy.activeFallbackContext = runtimeContext;
      policy.activeCapabilityRefresh = clientOptions[MODEL_ROUTE_CAPABILITY_REFRESH];
      await refreshCapabilityForAttempt(policy, index + 1);
      if (config?.signal?.aborted === true) {
        throw createGraphAbortError();
      }
      const fallbackInput = await prepareFallbackInvocationInput(
        { finalMessages: state?.messages },
        config,
        policy,
      );
      policy.activeRoute = {
        provider: runtimeContext.provider || fallback?.provider,
        reasoningKey: runtimeContext.reasoningKey,
        clientOptions: cloneClientOptionsWithoutFallbacks(clientOptions),
        systemRunnable: null,
      };
      const fallbackAuthoringBefore = authoringEvidenceSnapshot(graph);
      try {
        const result = await originalCallModel(
          { ...state, messages: fallbackInput.finalMessages },
          config,
        );
        recordGraphFallbackRecovery(graph, runtimeContext);
        return result;
      } catch (fallbackError) {
        lastError = fallbackError;
        if (
          config?.signal?.aborted === true ||
          hasNewAuthoringEvidence(graph, fallbackAuthoringBefore) ||
          !isRecoverableProviderFallbackError(fallbackError)
        ) {
          throw config?.signal?.aborted === true ? createGraphAbortError() : fallbackError;
        }
      }
    }
    throw lastError;
  } finally {
    policy.activeRoute = null;
  }
}

function installUnifiedSchemaToolBindingPatch(proto = StandardGraph?.prototype) {
  if (!proto || typeof proto.createCallModel !== 'function') {
    logger.warn('[Agent Schema Tool Binding Patch] StandardGraph.createCallModel unavailable');
    return false;
  }
  if (proto[PATCH_FLAG] === true) {
    return true;
  }

  const originalCreateCallModel = proto.createCallModel;
  const originalResetValues = proto.resetValues;
  if (typeof originalResetValues === 'function') {
    proto.resetValues = function patchedResetValues(...args) {
      if (Object.prototype.hasOwnProperty.call(this, 'viventiumGraphFallbackRecoveryReceipt')) {
        delete this.viventiumGraphFallbackRecoveryReceipt;
      }
      return originalResetValues.apply(this, args);
    };
  }
  const originalAttemptInvoke = proto.attemptInvoke;
  const usesLegacyFallbackHooks = typeof originalAttemptInvoke === 'function';
  if (typeof originalAttemptInvoke === 'function') {
    proto.attemptInvoke = async function patchedAttemptInvoke(input, config, ...rest) {
      if (config?.signal?.aborted === true) {
        throw createGraphAbortError();
      }
      const policy = fallbackInvocationPolicy.getStore();
      if (policy?.blockedError) {
        throw policy.blockedError;
      }
      const attemptIndex = policy?.attemptCount ?? 0;
      const authoringBefore = authoringEvidenceSnapshot(this);
      if (policy) {
        policy.attemptCount += 1;
      }
      try {
        await refreshCapabilityForAttempt(policy, attemptIndex);
        if (config?.signal?.aborted === true) {
          throw createGraphAbortError();
        }
        const invocationInput =
          attemptIndex > 0
            ? await prepareFallbackInvocationInput(input, config, policy)
            : preparePrimaryInvocationInput(input, policy);
        const result = await originalAttemptInvoke.call(this, invocationInput, config, ...rest);
        if (attemptIndex > 0) {
          recordGraphFallbackRecovery(this, policy?.activeFallbackContext);
        }
        return result;
      } catch (error) {
        if (policy && attemptIndex === 0) {
          const primaryAuthored = hasNewAuthoringEvidence(this, authoringBefore);
          if (primaryAuthored || !isRecoverableProviderFallbackError(error)) {
            policy.blockedError = error;
          }
        }
        throw error;
      }
    };
  }
  const originalGetNewModel = proto.getNewModel;
  if (typeof originalGetNewModel === 'function') {
    proto.getNewModel = function patchedGetNewModel(...args) {
      const blockedError = fallbackInvocationPolicy.getStore()?.blockedError;
      if (blockedError) {
        throw blockedError;
      }
      const clientOptions = args[0]?.clientOptions;
      const runtimeContext = clientOptions?.[GRAPH_FALLBACK_CONTEXT];
      const policy = fallbackInvocationPolicy.getStore();
      if (policy && runtimeContext) {
        policy.activeFallbackContext = runtimeContext;
        policy.activeCapabilityRefresh = clientOptions?.[MODEL_ROUTE_CAPABILITY_REFRESH];
      }
      return originalGetNewModel.apply(this, args);
    };
  }
  proto.createCallModel = function patchedCreateCallModel(agentId = 'default', ...rest) {
    const originalCallModel = originalCreateCallModel.call(this, agentId, ...rest);
    if (typeof originalCallModel !== 'function') {
      return originalCallModel;
    }

    return async (state, config) => {
      const invokeWithFallbackPolicy = () => {
        const policy = {
          attemptCount: 0,
          blockedError: null,
          activeFallbackContext: null,
          activeFallbackInstructionAppend: '',
          activeCapabilityRefresh: null,
          activeCapabilityRefreshResult: null,
          activeRoute: null,
          agentContext,
          baseClientOptions: agentContext?.clientOptions,
          baseProvider: agentContext?.provider,
          baseReasoningKey: agentContext?.reasoningKey,
          baseSystemRunnable: agentContext?.systemRunnable,
        };
        return fallbackInvocationPolicy.run(policy, () =>
          usesLegacyFallbackHooks
            ? originalCallModel(state, config)
            : invokeModernFallbackPolicy({
                graph: this,
                agentContext,
                originalCallModel,
                state,
                config,
                policy,
              }),
        );
      };
      const agentContext = this?.agentContexts?.get?.(agentId);
      if (agentContext && !installScopedFallbackRouteAccessors(agentContext)) {
        logger.error(
          `[Agent Schema Tool Binding Patch] fallback route accessor unavailable agent=${agentId}`,
        );
      }
      if (agentContext && !installDedupedBindingMethod(agentContext)) {
        logger.error(
          `[Agent Schema Tool Binding Patch] binding dedupe unavailable agent=${agentId}`,
        );
        return invokeWithFallbackPolicy();
      }
      const getToolsForBinding =
        agentContext && typeof agentContext.getToolsForBinding === 'function'
          ? agentContext.getToolsForBinding
          : null;
      const baseTools = agentContext?.tools;

      if (agentContext && getToolsForBinding) {
        const unifiedTools = getToolsForBinding.call(agentContext);
        if (
          Array.isArray(unifiedTools) &&
          unifiedTools.length > 0 &&
          !sameToolList(baseTools, unifiedTools)
        ) {
          const beforeSummary = summarizeTools(baseTools);
          const unifiedSummary = summarizeTools(unifiedTools);
          if (!installScopedToolsAccessor(agentContext)) {
            logger.error(
              `[Agent Schema Tool Binding Patch] tools accessor unavailable agent=${agentId}`,
            );
            return invokeWithFallbackPolicy();
          }
          logger.info(
            '[Agent Schema Tool Binding Patch] scoped unified schema tools ' +
              `agent=${agentId} previous_tools=${beforeSummary.count} ` +
              `binding_tools=${unifiedSummary.count} has_file_search=${unifiedSummary.hasFileSearch} ` +
              `sample=${unifiedSummary.sample}`,
          );
          const scopedValue =
            Array.isArray(agentContext.toolDefinitions) && agentContext.toolDefinitions.length > 0
              ? () => agentContext.getToolsForBinding()
              : unifiedTools;
          return scopedTools.run(
            new Map([[agentContext, { value: scopedValue, computingBinding: false }]]),
            () => invokeWithFallbackPolicy(),
          );
        }
      }

      return invokeWithFallbackPolicy();
    };
  };

  Object.defineProperty(proto, PATCH_FLAG, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  logger.info('[Agent Schema Tool Binding Patch] Installed unified schema-tool binding guard');
  return true;
}

try {
  installUnifiedSchemaToolBindingPatch();
} catch (error) {
  logger.error(
    `[Agent Schema Tool Binding Patch] Failed to install: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

module.exports = {
  dedupeToolsByName,
  installUnifiedSchemaToolBindingPatch,
  sameToolList,
};
