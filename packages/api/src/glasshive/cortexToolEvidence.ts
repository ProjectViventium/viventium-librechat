import { Tools } from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';

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
    verifiedReceiptCount: () =>
      requirements.filter((required) => sources.has(required.tool)).length,
    observeGrant(grantId: string) {
      if (closed || (!requirements.length && !onHostToolResult) || !grantId || grants.has(grantId))
        return;
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

/** Keep source artifacts on the canonical message; model text never creates a citation receipt. */
export function collectCortexCitationAttachments(
  parts: readonly ({ attachments?: TAttachment[] } | null | undefined)[],
  binding: { messageId: string; conversationId: string },
): TAttachment[] {
  if (!binding.messageId || !binding.conversationId) return [];
  const seen = new Set<string>();
  return parts
    .flatMap((part) => (Array.isArray(part?.attachments) ? part.attachments : []))
    .filter((attachment) => {
      const result = attachment?.[Tools.file_search];
      const sources = result && 'sources' in result ? result.sources : undefined;
      if (
        attachment?.type !== Tools.file_search ||
        attachment.messageId !== binding.messageId ||
        attachment.conversationId !== binding.conversationId ||
        !Array.isArray(sources) ||
        sources.length === 0
      )
        return false;
      const identity = JSON.stringify(attachment);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}
