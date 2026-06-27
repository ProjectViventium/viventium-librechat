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
 * - For the duration of one model call, expose the already-computed unified list
 *   through `agentContext.tools` and `getToolsForBinding()` so primary invoke
 *   metadata and fallback binding use the same tool set.
 * Added: 2026-06-25
 * === VIVENTIUM END === */
'use strict';

const { logger } = require('@librechat/data-schemas');
const { StandardGraph } = require('@librechat/agents');

const PATCH_FLAG = Symbol.for('viventium.agent.schema.tool.binding.patch.v1');

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
  return left.every((tool, index) => tool === right[index] || toolName(tool) === toolName(right[index]));
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
      const originalGetToolsForBinding =
        agentContext && typeof agentContext.getToolsForBinding === 'function'
          ? agentContext.getToolsForBinding
          : null;
      const originalTools = agentContext?.tools;
      const hadOwnGetToolsForBinding =
        agentContext != null &&
        Object.prototype.hasOwnProperty.call(agentContext, 'getToolsForBinding');
      const hadOwnTools =
        agentContext != null && Object.prototype.hasOwnProperty.call(agentContext, 'tools');
      let restoreAgentContext = null;

      if (agentContext && originalGetToolsForBinding) {
        const unifiedTools = originalGetToolsForBinding.call(agentContext);
        if (Array.isArray(unifiedTools) && unifiedTools.length > 0 && !sameToolList(originalTools, unifiedTools)) {
          const beforeSummary = summarizeTools(originalTools);
          const unifiedSummary = summarizeTools(unifiedTools);
          agentContext.tools = unifiedTools;
          agentContext.getToolsForBinding = () => unifiedTools;
          logger.info(
            '[Agent Schema Tool Binding Patch] exposed unified schema tools ' +
              `agent=${agentId} previous_tools=${beforeSummary.count} ` +
              `binding_tools=${unifiedSummary.count} has_file_search=${unifiedSummary.hasFileSearch} ` +
              `sample=${unifiedSummary.sample}`,
          );
          restoreAgentContext = () => {
            if (hadOwnTools) {
              agentContext.tools = originalTools;
            } else {
              delete agentContext.tools;
            }
            if (hadOwnGetToolsForBinding) {
              agentContext.getToolsForBinding = originalGetToolsForBinding;
            } else {
              delete agentContext.getToolsForBinding;
            }
          };
        }
      }

      try {
        return await originalCallModel(state, config);
      } finally {
        restoreAgentContext?.();
      }
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
  installUnifiedSchemaToolBindingPatch,
  sameToolList,
};
