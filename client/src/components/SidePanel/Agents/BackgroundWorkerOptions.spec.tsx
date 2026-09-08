import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import type { TAgentProviderCapability } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import BackgroundWorkerOptions from './BackgroundWorkerOptions';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => require('~/locales/en/translation.json')[key] || key,
}));

const capability = {
  models: [
    { id: 'model-primary', label: 'Primary', harnessProfile: 'codex-cli', effortChoices: ['low', 'medium'], recommendedEffort: 'medium' },
    { id: 'model-fallback', label: 'Fallback', harnessProfile: 'claude-code', effortChoices: ['low', 'medium', 'high'], recommendedEffort: 'medium' },
  ],
} as TAgentProviderCapability;
function Harness({ snapshot, unknown = false }: { snapshot: jest.Mock; unknown?: boolean }) {
  const methods = useForm<AgentForm>({ defaultValues: {
    model: 'main-model', model_parameters: { reasoning_effort: 'low' },
    glasshive_options: { workspace: { mode: 'life' }, access: 'full', orchestration: {
      parallel_available: true, default_mode: 'parallel', worker_profile: 'codex-cli',
      worker_model: unknown ? 'unavailable-model' : 'model-primary', worker_reasoning_effort: 'medium',
      fallback_worker_model: 'model-fallback', fallback_worker_reasoning_effort: 'medium',
    } },
  } });
  return <FormProvider {...methods}><BackgroundWorkerOptions providerCapability={capability} />
    <button onClick={() => snapshot(methods.getValues())}>Save snapshot</button></FormProvider>;
}
it('reopens independent saved worker selections without changing Main', () => {
  const snapshot = jest.fn(); render(<Harness snapshot={snapshot} />);
  expect(screen.getByLabelText('Background model')).toHaveValue('model-primary');
  expect(screen.getByLabelText('Background model effort')).toHaveValue('medium');
  expect(screen.getByLabelText('Background fallback model effort')).toHaveValue('medium');
  fireEvent.change(screen.getByLabelText('Background fallback model effort'), { target: { value: 'high' } });
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[0][0]).toMatchObject({ model: 'main-model', model_parameters: {reasoning_effort:'low'}, glasshive_options: {orchestration: {
    worker_model:'model-primary', worker_reasoning_effort:'medium', fallback_worker_reasoning_effort:'high', worker_profile:'codex-cli',
  }} });
});
it('retains unavailable saved values until an explicit model selection', () => {
  const snapshot=jest.fn(); render(<Harness snapshot={snapshot} unknown />);
  expect(screen.getByLabelText('Background model')).toHaveValue('unavailable-model');
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[0][0].glasshive_options.orchestration.worker_model).toBe('unavailable-model');
  fireEvent.change(screen.getByLabelText('Background model'),{target:{value:'model-primary'}});
  expect(screen.getByLabelText('Background model effort')).toHaveValue('medium');
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[1][0].model_parameters.reasoning_effort).toBe('low');
});
it('clears only worker preference when choosing profile defaults', () => {
  const snapshot=jest.fn(); render(<Harness snapshot={snapshot} />);
  fireEvent.change(screen.getByLabelText('Background model'),{target:{value:''}});
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[0][0].glasshive_options.orchestration).toMatchObject({worker_model:'',worker_reasoning_effort:'',fallback_worker_model:'model-fallback',fallback_worker_reasoning_effort:'medium'});
});

it('uses declared harness metadata on an explicit model change', () => {
  const snapshot=jest.fn(); render(<Harness snapshot={snapshot} />);
  fireEvent.change(screen.getByLabelText('Background model'),{target:{value:'model-fallback'}});
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[0][0].glasshive_options.orchestration.worker_profile).toBe('claude-code');
  expect(snapshot.mock.calls[0][0].model).toBe('main-model');
});
