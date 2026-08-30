/* === VIVENTIUM START ===
 * Feature: Source-component starts for cyclic multi-agent graphs.
 * Purpose: Start one deterministic entrypoint from each source strongly connected component.
 * === VIVENTIUM END === */

export interface AgentGraphEdge {
  from?: string | readonly string[];
  to?: string | readonly string[];
}

interface MultiAgentGraphRuntime {
  agentContexts: Map<string, object>;
  edges: readonly AgentGraphEdge[];
  startingNodes: Set<string>;
  agentParallelGroups: Map<string, number>;
  computeParallelCapability(): void;
}

interface MultiAgentGraphPrototype {
  analyzeGraph(this: MultiAgentGraphRuntime): void;
  [key: symbol]: unknown;
}

export interface MultiAgentGraphModule {
  MultiAgentGraph?: { prototype?: MultiAgentGraphPrototype };
}

const PATCH_MARKER = Symbol.for('viventium.librechat_agents.source_component_starts.v1');

function endpoints(value: string | readonly string[] | undefined): readonly string[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

export function sourceComponentStartAgentIds(
  agentIds: readonly string[] | null | undefined,
  edges: readonly AgentGraphEdge[] | null | undefined,
): string[] {
  const orderedIds = [...new Set((Array.isArray(agentIds) ? agentIds : []).filter(Boolean))];
  const knownIds = new Set(orderedIds);
  const adjacency = new Map(orderedIds.map((agentId) => [agentId, new Set<string>()]));

  for (const edge of Array.isArray(edges) ? edges : []) {
    for (const source of endpoints(edge?.from)) {
      if (!knownIds.has(source)) continue;
      for (const target of endpoints(edge?.to)) {
        if (knownIds.has(target)) adjacency.get(source)?.add(target);
      }
    }
  }

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (agentId: string): void => {
    indices.set(agentId, nextIndex);
    lowLinks.set(agentId, nextIndex);
    nextIndex += 1;
    stack.push(agentId);
    onStack.add(agentId);

    for (const target of adjacency.get(agentId) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(agentId, Math.min(lowLinks.get(agentId) ?? 0, lowLinks.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowLinks.set(agentId, Math.min(lowLinks.get(agentId) ?? 0, indices.get(target) ?? 0));
      }
    }

    if (lowLinks.get(agentId) !== indices.get(agentId)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
      if (member === agentId) break;
    }
    components.push(component);
  };

  for (const agentId of orderedIds) {
    if (!indices.has(agentId)) visit(agentId);
  }

  const componentByAgent = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    component.forEach((agentId) => componentByAgent.set(agentId, componentIndex));
  });
  const incomingComponents = new Set<number>();
  for (const [source, targets] of adjacency) {
    const sourceComponent = componentByAgent.get(source);
    for (const target of targets) {
      const targetComponent = componentByAgent.get(target);
      if (sourceComponent !== targetComponent && targetComponent !== undefined) {
        incomingComponents.add(targetComponent);
      }
    }
  }

  const selectedComponents = new Set<number>();
  const starts: string[] = [];
  for (const agentId of orderedIds) {
    const componentIndex = componentByAgent.get(agentId);
    if (
      componentIndex === undefined ||
      incomingComponents.has(componentIndex) ||
      selectedComponents.has(componentIndex)
    ) {
      continue;
    }
    selectedComponents.add(componentIndex);
    starts.push(agentId);
  }
  return starts;
}

export function installLibreChatAgentsGraphStartPatch(
  agentsModule: MultiAgentGraphModule | null | undefined,
): boolean {
  const prototype = agentsModule?.MultiAgentGraph?.prototype;
  if (!prototype || typeof prototype.analyzeGraph !== 'function') return false;
  if (prototype[PATCH_MARKER] === true) return true;

  prototype.analyzeGraph = function analyzeGraphBySourceComponent() {
    const agentIds = [...this.agentContexts.keys()];
    const starts = sourceComponentStartAgentIds(agentIds, this.edges);
    this.startingNodes.clear();
    this.agentParallelGroups.clear();
    for (const agentId of starts) this.startingNodes.add(agentId);
    if (this.startingNodes.size === 0 && agentIds.length > 0) {
      this.startingNodes.add(agentIds[0]);
    }
    this.computeParallelCapability();
  };
  Object.defineProperty(prototype, PATCH_MARKER, { value: true });
  return true;
}

/* === VIVENTIUM END === */
