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
const { logger } = require('@librechat/data-schemas');
const { StandardGraph } = require('@librechat/agents');

const PATCH_FLAG = Symbol.for('viventium.agent.schema.tool.binding.patch.v2');
const SCOPED_TOOLS_FLAG = Symbol.for('viventium.agent.schema.tool.binding.accessor.v1');
const DEDUPED_BINDING_FLAG = Symbol.for('viventium.agent.schema.tool.binding.dedupe.v1');
const scopedTools = new AsyncLocalStorage();

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
  Object.defineProperty(agentContext, 'tools', {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get() {
      const scopedValue = scopedTools.getStore()?.get(agentContext);
      if (typeof scopedValue !== 'function') {
        return scopedValue ?? baseTools;
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

function installUnifiedSchemaToolBindingPatch(proto = StandardGraph?.prototype) {
  if (!proto || typeof proto.createCallModel !== 'function') {
    logger.warn('[Agent Schema Tool Binding Patch] StandardGraph.createCallModel unavailable');
    return false;
  }
  if (proto[PATCH_FLAG] === true) {
    return true;
  }

  const originalCreateCallModel = proto.createCallModel;
  proto.createCallModel = function patchedCreateCallModel(agentId = 'default', ...rest) {
    const originalCallModel = originalCreateCallModel.call(this, agentId, ...rest);
    if (typeof originalCallModel !== 'function') {
      return originalCallModel;
    }

    return async (state, config) => {
      const agentContext = this?.agentContexts?.get?.(agentId);
      if (agentContext && !installDedupedBindingMethod(agentContext)) {
        logger.error(
          `[Agent Schema Tool Binding Patch] binding dedupe unavailable agent=${agentId}`,
        );
        return originalCallModel(state, config);
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
            return originalCallModel(state, config);
          }
          logger.info(
            '[Agent Schema Tool Binding Patch] scoped unified schema tools ' +
              `agent=${agentId} previous_tools=${beforeSummary.count} ` +
              `binding_tools=${unifiedSummary.count} has_file_search=${unifiedSummary.hasFileSearch} ` +
              `sample=${unifiedSummary.sample}`,
          );
          const scopedValue =
            Array.isArray(agentContext.toolDefinitions) && agentContext.toolDefinitions.length > 0
              ? () => getToolsForBinding.call(agentContext)
              : unifiedTools;
          return scopedTools.run(new Map([[agentContext, scopedValue]]), () =>
            originalCallModel(state, config),
          );
        }
      }

      return originalCallModel(state, config);
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
