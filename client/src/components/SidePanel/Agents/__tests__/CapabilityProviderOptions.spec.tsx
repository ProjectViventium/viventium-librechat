/** @jest-environment jsdom */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import CapabilityProviderOptions from '../CapabilityProviderOptions';
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: { status: 'ready_to_try', models: [] },
    isLoading: false,
    refetch: jest.fn(),
  }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
function Wrapper({ direct }: { direct: boolean }) {
  const form = useForm({
    defaultValues: { glasshive_options: { access: 'full', workspace: { mode: 'life' } } },
  });
  return (
    <FormProvider {...form}>
      <CapabilityProviderOptions
        provider="synthetic"
        model="model"
        parameterField="voice_llm_model_parameters"
        providerCapability={
          {
            workspace_binding: true,
            allow_full_access: true,
            worker_native_tools: true,
            models: [
              {
                id: 'model',
                label: 'Model',
                executionBackend: direct ? 'direct-api' : 'native-harness',
                effortChoices: ['low', 'high'],
              },
            ],
          } as never
        }
      />
    </FormProvider>
  );
}
it('Direct shows truthful API readiness and tools, keeps context and effort, hides native sandbox claims', () => {
  render(<Wrapper direct />);
  expect(screen.getByText('com_ui_glasshive_connection_configured')).toBeTruthy();
  expect(screen.getByText('com_ui_glasshive_direct_description')).toBeTruthy();
  expect(screen.getByLabelText('com_ui_glasshive_working_folder')).toBeTruthy();
  expect(screen.getByLabelText('com_ui_glasshive_effort')).toBeTruthy();
  expect(screen.queryByLabelText('com_ui_glasshive_access')).toBeNull();
  expect(screen.queryByText('com_ui_glasshive_native_tools_description')).toBeNull();
});
it('native harness keeps its workspace sandbox and tool controls', () => {
  render(<Wrapper direct={false} />);
  expect(screen.getByLabelText('com_ui_glasshive_access')).toBeTruthy();
  expect(screen.getByText('com_ui_glasshive_harness_description')).toBeTruthy();
});
