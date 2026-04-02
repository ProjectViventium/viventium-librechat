export function resolveSelectedAgentIdForApply(
  currentAgentId?: string | null,
  formAgentId?: string | null,
): string {
  return formAgentId || currentAgentId || '';
}
