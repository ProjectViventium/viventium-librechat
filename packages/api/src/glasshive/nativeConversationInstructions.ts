/* === VIVENTIUM START === Inherit the existing action-capable Native instruction source. === */
import { getRequiredPromptText } from '../prompts/runtime';

export function inheritNativeConversationCapabilityInventory(
  bundle: Record<string, unknown>,
  { nativeTools }: { nativeTools: boolean },
) {
  const capabilities = bundle.provider_capabilities;
  if (
    !nativeTools ||
    bundle.conversation_tool_mode === 'coordination' ||
    (capabilities &&
      typeof capabilities === 'object' &&
      'native_tools' in capabilities &&
      capabilities.native_tools === false)
  )
    return bundle;

  const inventory = getRequiredPromptText('worker.native_capability_inventory');
  const fields = (['agents_md', 'codex_md', 'claude_md'] as const).filter(
    (field) => typeof bundle[field] === 'string' && String(bundle[field]).trim(),
  );
  const inherited = Object.fromEntries(
    (fields.length ? fields : ['agents_md']).map((field) => {
      const current = typeof bundle[field] === 'string' ? String(bundle[field]) : '';
      return [
        field,
        current.includes(inventory) ? current : [current, inventory].filter(Boolean).join('\n\n'),
      ];
    }),
  );
  return { ...bundle, ...inherited };
}
/* === VIVENTIUM END === */
