import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import type { TAgentProviderCapability } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import ModelPanel from './ModelPanel';

jest.mock('@librechat/client', () => ({
  ControlCombobox: () => <div data-testid="control-combobox" />,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('./ModelParametersSection', () => ({
  __esModule: true,
  default: () => null,
}));

const providerCapability = {
  workspace_binding: false,
  serial_model_fallback: true,
  models: [
    { id: 'primary-model', label: 'Primary model' },
    {
      id: 'fallback-model',
      label: 'Fallback model',
      effortChoices: ['medium', 'high'],
      recommendedEffort: 'high',
    },
  ],
} as TAgentProviderCapability;

function Harness() {
  const methods = useForm<AgentForm>({
    defaultValues: {
      provider: 'glasshive-harness',
      model: 'primary-model',
      model_parameters: {},
      glasshive_options: {
        fallback_model: 'fallback-model',
      },
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return (
    <QueryClientProvider client={queryClient}>
      <FormProvider {...methods}>
        <ModelPanel
          providers={['glasshive-harness']}
          models={{ 'glasshive-harness': ['primary-model', 'fallback-model'] }}
          setActivePanel={jest.fn()}
          providerCapabilities={{ 'glasshive-harness': providerCapability }}
        />
      </FormProvider>
    </QueryClientProvider>
  );
}

describe('ModelPanel serial fallback controls', () => {
  it('preserves the configured quota fallback model and its capability-backed effort choices', () => {
    render(<Harness />);

    const fallbackModel = screen.getByLabelText('com_ui_glasshive_quota_fallback_model');
    expect(fallbackModel).toHaveValue('fallback-model');
    expect(within(fallbackModel).queryByRole('option', { name: 'Primary model' })).toBeNull();
    expect(
      within(fallbackModel).getByRole('option', { name: 'Fallback model' }),
    ).toBeInTheDocument();

    const fallbackEffort = screen.getByLabelText('com_ui_glasshive_quota_fallback_effort');
    expect(fallbackEffort).toHaveValue('high');
    expect(
      within(fallbackEffort).getByRole('option', { name: 'high (com_ui_glasshive_recommended)' }),
    ).toBeInTheDocument();
  });
});
