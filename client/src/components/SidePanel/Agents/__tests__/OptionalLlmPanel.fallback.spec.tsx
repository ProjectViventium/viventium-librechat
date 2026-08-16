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
      models: [{ id: 'claude-code:opus', readiness: { status: 'ready' } }],
    },
    isLoading: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    key === 'com_ui_glasshive_authenticated_ready' ? 'Authenticated and ready' : key,
}));

jest.mock('~/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' '),
}));

let modelParametersProps: Record<string, unknown> | undefined;
jest.mock('../ModelParametersSection', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    modelParametersProps = props;
    return null;
  },
}));

let formMethods: UseFormReturn<AgentForm>;

function Wrapper() {
  formMethods = useForm<AgentForm>({
    defaultValues: {
      fallback_llm_provider: 'glasshive-harness',
      fallback_llm_model: 'claude-code:opus',
      fallback_llm_model_parameters: {},
    },
  });
  return (
    <FormProvider {...formMethods}>
      <OptionalLlmPanel
        models={{ 'glasshive-harness': ['claude-code:opus'] }}
        providers={[{ value: 'glasshive-harness', label: 'GlassHive' }]}
        providerCapabilities={
          {
            'glasshive-harness': {
              label: 'GlassHive',
              workspace_binding: true,
              models: [
                {
                  id: 'claude-code:opus',
                  label: 'Claude / Opus 5',
                  effortChoices: ['low', 'medium', 'high', 'xhigh', 'max'],
                  recommendedEffort: 'high',
                },
              ],
            },
          } as any
        }
        setActivePanel={jest.fn()}
        title="Fallback LLM"
        description="Fallback route"
        clearLabel="Clear"
        fields={{
          provider: 'fallback_llm_provider',
          model: 'fallback_llm_model',
          parameters: 'fallback_llm_model_parameters',
        }}
      />
    </FormProvider>
  );
}

describe('OptionalLlmPanel capability-backed fallback route', () => {
  it('renders Opus 5 readiness and persists the capability-recommended high effort', async () => {
    render(<Wrapper />);

    expect(screen.getAllByText('GlassHive').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Claude / Opus 5').length).toBeGreaterThan(0);
    expect(screen.getByText('Authenticated and ready')).toBeInTheDocument();

    const effort = document.querySelector(
      '#fallback_llm_model_parameters-effort',
    ) as HTMLSelectElement;
    await waitFor(() => {
      expect(effort.value).toBe('high');
      expect(formMethods.getValues('fallback_llm_model_parameters.reasoning_effort')).toBe('high');
      expect(formMethods.getValues('glasshive_options')).toEqual({
        workspace: { mode: 'life' },
        access: 'full',
      });
    });

    fireEvent.change(effort, { target: { value: 'xhigh' } });
    expect(formMethods.getValues('fallback_llm_model_parameters.reasoning_effort')).toBe('xhigh');
    expect(modelParametersProps?.excludedParameterKeys).toEqual(['reasoning_effort']);
  });
});
