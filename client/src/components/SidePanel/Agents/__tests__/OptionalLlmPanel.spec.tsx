/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormProvider, useForm, type UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import OptionalLlmPanel from '../OptionalLlmPanel';

jest.mock('lucide-react', () => ({
  ChevronLeft: () => <span aria-hidden="true" />,
  Trash2: () => <span aria-hidden="true" />,
}));

jest.mock('@librechat/client', () => ({
  ControlCombobox: ({ displayValue, items, selectedValue, setValue, ariaLabel }: any) => (
    <div>
      <span>{displayValue}</span>
      <select
        aria-label={ariaLabel}
        value={selectedValue}
        onChange={(event) => setValue(event.target.value)}
      >
        {items.map((item: { label: string; value: string }) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      status: 'ready',
      detail: 'Provider ready',
      models: [{ id: 'codex-cli:gpt-5.6-sol', readiness: { status: 'ready' } }],
    },
    isLoading: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' '),
}));

jest.mock('../ModelParametersSection', () => ({
  __esModule: true,
  default: () => null,
}));

let formMethods: UseFormReturn<AgentForm>;

function Wrapper() {
  formMethods = useForm<AgentForm>({
    defaultValues: {
      voice_llm_provider: 'glasshive-harness',
      voice_llm_model: 'codex-cli:gpt-5.6-sol',
      voice_llm_model_parameters: { reasoning_effort: 'low' },
    },
  });
  return (
    <FormProvider {...formMethods}>
      <OptionalLlmPanel
        models={{ 'glasshive-harness': ['codex-cli:gpt-5.6-sol'] }}
        providers={[{ value: 'glasshive-harness', label: 'GlassHive' }]}
        providerCapabilities={
          {
            'glasshive-harness': {
              label: 'GlassHive',
              workspace_binding: true,
              default_access: 'full',
              allow_full_access: true,
              models: [
                {
                  id: 'codex-cli:gpt-5.6-sol',
                  label: 'Codex / GPT-5.6 Sol',
                  effortChoices: ['low', 'medium', 'high'],
                  recommendedEffort: 'medium',
                },
              ],
            },
          } as any
        }
        setActivePanel={jest.fn()}
        title="Voice Call LLM"
        description="Voice route"
        clearLabel="Clear"
        fields={{
          provider: 'voice_llm_provider',
          model: 'voice_llm_model',
          parameters: 'voice_llm_model_parameters',
        }}
      />
    </FormProvider>
  );
}

describe('OptionalLlmPanel capability-backed voice route', () => {
  it('renders friendly GlassHive labels, low effort, readiness, and LIFE/full defaults', async () => {
    render(<Wrapper />);

    expect(screen.getAllByText('GlassHive').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Codex / GPT-5.6 Sol').length).toBeGreaterThan(0);
    expect(screen.getByText('com_ui_glasshive_authenticated_ready')).toBeInTheDocument();

    const effort = document.querySelector(
      '#voice_llm_model_parameters-effort',
    ) as HTMLSelectElement;
    expect(effort.value).toBe('low');
    fireEvent.change(effort, { target: { value: 'high' } });
    expect(formMethods.getValues('voice_llm_model_parameters.reasoning_effort')).toBe('high');

    await waitFor(() => {
      expect(formMethods.getValues('glasshive_options')).toEqual({
        workspace: { mode: 'life' },
        access: 'full',
      });
    });
  });
});
