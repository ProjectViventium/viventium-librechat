import React from 'react';
import { render } from '@testing-library/react';
import { ModelSelectorProvider } from '../ModelSelectorContext';

const mockGetConversation = jest.fn();
const mockNewConversation = jest.fn();
const mockUseSelectMention = jest.fn(() => ({
  onSelectEndpoint: jest.fn(),
  onSelectSpec: jest.fn(),
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: jest.fn(() => undefined),
  useAssistantsMapContext: jest.fn(() => undefined),
  useLiveAnnouncer: jest.fn(() => ({ announcePolite: jest.fn() })),
}));

jest.mock('~/hooks', () => ({
  useAgentDefaultPermissionLevel: jest.fn(() => 'edit'),
  useSelectorEffects: jest.fn(),
  useKeyDialog: jest.fn(() => ({})),
  useEndpoints: jest.fn(() => ({
    mappedEndpoints: [],
    endpointRequiresUserKey: jest.fn(() => false),
  })),
  useLocalize: jest.fn(() => (key: string) => key),
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.fn(() => ({ data: {} })),
  useListAgentsQuery: jest.fn(() => ({ data: null })),
}));

jest.mock('../ModelSelectorChatContext', () => ({
  useModelSelectorChatContext: jest.fn(() => ({
    endpoint: null,
    model: '',
    spec: '',
    agent_id: '',
    assistant_id: '',
    getConversation: mockGetConversation,
    newConversation: mockNewConversation,
  })),
}));

jest.mock('~/hooks/Input/useSelectMention', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseSelectMention(...args),
}));

describe('ModelSelectorProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes getConversation into useSelectMention', () => {
    render(
      <ModelSelectorProvider startupConfig={{ modelSpecs: { list: [] } } as any}>
        <div>child</div>
      </ModelSelectorProvider>,
    );

    expect(mockUseSelectMention).toHaveBeenCalledTimes(1);
    const params = mockUseSelectMention.mock.calls[0][0];
    expect(params.getConversation).toBe(mockGetConversation);
    expect(params.conversation).toBeUndefined();
  });
});
