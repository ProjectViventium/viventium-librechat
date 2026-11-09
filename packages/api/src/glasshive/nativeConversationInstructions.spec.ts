import { getRequiredPromptText } from '../prompts/runtime';
import { inheritNativeConversationCapabilityInventory } from './nativeConversationInstructions';

jest.mock('../prompts/runtime', () => ({ getRequiredPromptText: jest.fn() }));
const inventory =
  'Existing registered capability inventory.\nPrefer undisturbed background interaction.';
beforeEach(() => jest.mocked(getRequiredPromptText).mockReturnValue(inventory));

test('inherits the unchanged source into each existing profile carrier without changing policy', () => {
  const bundle = {
    agents_md: 'Common current context.',
    codex_md: 'Existing Codex authority.',
    claude_md: 'Existing Claude authority.',
    provider_capabilities: { native_tools: true, self_delegation: false },
    glasshive_capability_broker: { grant_id: 'authorized-current-grant' },
    inherited_conversation: { sources: [{ text: 'Exact original.  ' }] },
  };
  const original = structuredClone(bundle);
  const result = inheritNativeConversationCapabilityInventory(bundle, { nativeTools: true });
  for (const field of ['agents_md', 'codex_md', 'claude_md'] as const)
    expect(result[field]).toBe(`${bundle[field]}\n\n${inventory}`);
  expect(result.provider_capabilities).toBe(bundle.provider_capabilities);
  expect(result.glasshive_capability_broker).toBe(bundle.glasshive_capability_broker);
  expect(result.inherited_conversation).toBe(bundle.inherited_conversation);
  expect(bundle).toEqual(original);
  expect(getRequiredPromptText).toHaveBeenCalledWith('worker.native_capability_inventory');
});

test.each([
  [{ agents_md: 'Speaking authority.' }, false],
  [{ agents_md: 'Presentation authority.', provider_capabilities: { native_tools: false } }, true],
  [{ agents_md: 'Fast speaking authority.', conversation_tool_mode: 'coordination' }, true],
])(
  'control-only and tool-less roles keep their exact existing authority',
  (bundle, nativeTools) => {
    jest.mocked(getRequiredPromptText).mockClear();
    expect(inheritNativeConversationCapabilityInventory(bundle, { nativeTools })).toBe(bundle);
    expect(getRequiredPromptText).not.toHaveBeenCalled();
  },
);

test('the existing compiled source is present once when inheritance is repeated', () => {
  const once = inheritNativeConversationCapabilityInventory(
    { agents_md: 'Current context.' },
    { nativeTools: true },
  );
  const twice = inheritNativeConversationCapabilityInventory(once, { nativeTools: true });
  expect(twice).toEqual(once);
  expect(String(twice.agents_md).split(inventory)).toHaveLength(2);
});

test('an action-capable conversation with no broker still inherits its existing capability source', () => {
  expect(inheritNativeConversationCapabilityInventory({}, { nativeTools: true })).toEqual({
    agents_md: inventory,
  });
});

test('missing required source fails without a hidden prompt fallback', () => {
  jest.mocked(getRequiredPromptText).mockImplementation(() => {
    throw new Error('missing_required_prompt');
  });
  expect(() => inheritNativeConversationCapabilityInventory({}, { nativeTools: true })).toThrow(
    'missing_required_prompt',
  );
});
