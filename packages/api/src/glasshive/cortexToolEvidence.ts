// VIVENTIUM: Invocation-scoped evidence, shared by direct tools and the authenticated broker.
// Only receipt kinds declared in the agent schema are interpreted here. Models own relevance.
type ToolResult = { name?: string; artifact?: Record<string, { sources?: unknown[] }> };
type EvidencePolicy = {
  visible_insight_requires?: Array<{ tool: string; receipt: 'non_empty_sources' }>;
};
const grantObservers = new Map<string, Set<(result: ToolResult) => void>>();

/** Called only after the broker authenticates the grant and executes an authorized host tool. */
export function reportCortexHostToolResult(
  grantId: string,
  result: { status?: string; tool?: string; artifact?: ToolResult['artifact'] },
): void {
  if (result.status !== 'ok') return;
  for (const observer of grantObservers.get(grantId) ?? []) {
    observer({ name: result.tool, artifact: result.artifact });
  }
}

export function createCortexToolEvidence(
  policy?: EvidencePolicy | null,
  onHostToolResult?: (result: ToolResult) => void,
) {
  const requirements = policy?.visible_insight_requires ?? [];
  const sources = new Set<string>();
  const grants = new Set<string>();
  let closed = false;
  const record = (result: ToolResult) => {
    if (closed || !result.name) return;
    const found = result.artifact?.[result.name]?.sources;
    if (Array.isArray(found) && found.some((source) => source && typeof source === 'object')) {
      sources.add(result.name);
    }
  };
  const observe = (result: ToolResult) => {
    record(result);
    onHostToolResult?.(result);
  };
  return {
    record,
    observeGrant(grantId: string) {
      if (closed || !requirements.length || !grantId || grants.has(grantId)) return;
      const observers = grantObservers.get(grantId) ?? new Set();
      observers.add(observe);
      grantObservers.set(grantId, observers);
      grants.add(grantId);
    },
    isSatisfied: () =>
      requirements.every(
        (required) => required.receipt === 'non_empty_sources' && sources.has(required.tool),
      ),
    close() {
      closed = true;
      for (const grant of grants) {
        const observers = grantObservers.get(grant);
        observers?.delete(observe);
        if (!observers?.size) grantObservers.delete(grant);
      }
      grants.clear();
    },
  };
}
