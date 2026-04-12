/**
 * @jest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { render, waitFor } from '@testing-library/react';

const mockReset = jest.fn();

jest.mock('react-hook-form', () => ({
  useFormContext: () => ({
    control: {},
    reset: mockReset,
  }),
  Controller: ({ render }: { render: (props: { field: { value: undefined } }) => React.ReactNode }) =>
    render({ field: { value: undefined } }),
}));

jest.mock('@librechat/client', () => ({
  ControlCombobox: () => <div>{`Agent Combobox`}</div>,
}));

jest.mock('librechat-data-provider', () => ({
  AgentCapabilities: {
    web_search: 'web_search',
    file_search: 'file_search',
    execute_code: 'execute_code',
    end_after_tools: 'end_after_tools',
    hide_sequential_outputs: 'hide_sequential_outputs',
  },
  defaultAgentFormValues: {
    id: '',
    name: '',
    description: '',
    model: '',
    provider: '',
    model_parameters: {},
    voice_llm_model: null,
    voice_llm_provider: null,
    voice_llm_model_parameters: undefined,
  },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  createProviderOption: (provider: string) => ({ value: provider, label: provider }),
  processAgentOption: ({ agent }: { agent: { id: string; name: string; icon?: React.ReactNode } }) =>
    agent,
  getDefaultAgentFormValues: () => ({
    id: '',
    name: '',
    description: '',
    model: '',
    provider: '',
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAgentDefaultPermissionLevel: () => 'EDIT',
}));

jest.mock('~/data-provider', () => ({
  useListAgentsQuery: () => ({
    data: [],
  }),
}));

import AgentSelect from '../AgentSelect';

describe('AgentSelect', () => {
  beforeEach(() => {
    mockReset.mockReset();
  });

  it('preserves voice-only model parameters when loading an existing agent into the form', async () => {
    const agent = {
      id: 'agent_123',
      name: 'Voice Agent',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      tools: [],
      voice_llm_provider: 'anthropic',
      voice_llm_model: 'claude-haiku-4-5',
      voice_llm_model_parameters: {
        model: 'claude-haiku-4-5',
        temperature: 0.2,
        max_output_tokens: 220,
      },
    };

    render(
      <AgentSelect
        agentQuery={{ data: agent, isSuccess: true } as any}
        selectedAgentId={null}
        setCurrentAgentId={jest.fn()}
        createMutation={{ reset: jest.fn() } as any}
      />,
    );

    await waitFor(() => expect(mockReset).toHaveBeenCalledTimes(1));

    expect(mockReset.mock.calls[0][0]).toMatchObject({
      voice_llm_provider: 'anthropic',
      voice_llm_model: 'claude-haiku-4-5',
      voice_llm_model_parameters: {
        model: 'claude-haiku-4-5',
        temperature: 0.2,
        max_output_tokens: 220,
      },
    });
  });
});
