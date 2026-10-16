import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import type { TAgentProviderCapability } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import BackgroundWorkerOptions from './BackgroundWorkerOptions';

jest.mock('@librechat/client', () => ({
  ControlCombobox: ({
    items,
    selectedValue,
    setValue,
    ariaLabel,
  }: {
    items: Array<{ label: string; value: string }>;
    selectedValue: string;
    setValue: (value: string) => void;
    ariaLabel: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={selectedValue}
      onChange={(event) => setValue(event.target.value)}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    jest.requireActual('~/locales/en/translation.json')[key] || key,
}));

const capability = {
  allow_full_access: true,
  models: [
    {
      id: 'model-grok',
      label: 'Grok',
      harnessProfile: 'grok-build',
      effortChoices: ['high'],
      recommendedEffort: 'high',
    },
    {
      id: 'model-primary',
      label: 'Primary',
      harnessProfile: 'codex-cli',
      effortChoices: ['low', 'medium'],
      recommendedEffort: 'medium',
    },
    {
      id: 'model-fallback',
      label: 'Fallback',
      harnessProfile: 'claude-code',
      effortChoices: ['low', 'medium', 'high'],
      recommendedEffort: 'medium',
    },
  ],
} as TAgentProviderCapability;
function Harness({
  snapshot,
  unknown = false,
  restricted = false,
  nativeAccess,
}: {
  snapshot: jest.Mock;
  unknown?: boolean;
  restricted?: boolean;
  nativeAccess?: 'ask' | 'full';
}) {
  const methods = useForm<AgentForm>({
    defaultValues: {
      model: 'main-model',
      model_parameters: { reasoning_effort: 'low' },
      glasshive_options: {
        workspace: { mode: 'life' },
        access: 'full',
        orchestration: {
          parallel_available: true,
          default_mode: 'parallel',
          worker_access: nativeAccess,
          worker_profile: 'codex-cli',
          worker_model: unknown ? 'unavailable-model' : 'model-primary',
          worker_reasoning_effort: 'medium',
          fallback_worker_model: 'model-fallback',
          fallback_worker_reasoning_effort: 'medium',
        },
      },
    },
  });
  return (
    <FormProvider {...methods}>
      <BackgroundWorkerOptions
        providerCapability={restricted ? { ...capability, allow_full_access: false } : capability}
      />
      <button onClick={() => snapshot(methods.getValues())}>{'Save snapshot'}</button>
    </FormProvider>
  );
}
it('reopens independent saved worker selections without changing Main', () => {
  const snapshot = jest.fn();
  render(<Harness snapshot={snapshot} />);
  expect(screen.getByLabelText('Background model')).toHaveValue('model-primary');
  expect(screen.getByLabelText('Background model effort')).toHaveValue('medium');
  expect(screen.getByLabelText('Background fallback model effort')).toHaveValue('medium');
  fireEvent.change(screen.getByLabelText('Background fallback model effort'), {
    target: { value: 'high' },
  });
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[0][0]).toMatchObject({
    model: 'main-model',
    model_parameters: { reasoning_effort: 'low' },
    glasshive_options: {
      orchestration: {
        worker_model: 'model-primary',
        worker_reasoning_effort: 'medium',
        fallback_worker_reasoning_effort: 'high',
        worker_profile: 'codex-cli',
      },
    },
  });
});
it('retains unavailable saved values until an explicit model selection', () => {
  const snapshot = jest.fn();
  render(<Harness snapshot={snapshot} unknown />);
  expect(screen.getByLabelText('Background model')).toHaveValue('unavailable-model');
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[0][0].glasshive_options.orchestration.worker_model).toBe(
    'unavailable-model',
  );
  fireEvent.change(screen.getByLabelText('Background model'), {
    target: { value: 'model-primary' },
  });
  expect(screen.getByLabelText('Background model effort')).toHaveValue('medium');
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[1][0].model_parameters.reasoning_effort).toBe('low');
});
it('clears only worker preference when choosing profile defaults', () => {
  const snapshot = jest.fn();
  render(<Harness snapshot={snapshot} />);
  fireEvent.change(screen.getByLabelText('Background model'), { target: { value: '' } });
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[0][0].glasshive_options.orchestration).toMatchObject({
    worker_model: '',
    worker_reasoning_effort: '',
    fallback_worker_model: 'model-fallback',
    fallback_worker_reasoning_effort: 'medium',
  });
});

it('uses declared harness metadata on an explicit model change', () => {
  const snapshot = jest.fn();
  render(<Harness snapshot={snapshot} />);
  fireEvent.change(screen.getByLabelText('Background provider'), {
    target: { value: 'claude-code' },
  });
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[0][0].glasshive_options.orchestration.worker_profile).toBe(
    'claude-code',
  );
  expect(snapshot.mock.calls[0][0].model).toBe('main-model');
});

it('groups provider models and retains older supported efforts', () => {
  render(<Harness snapshot={jest.fn()} />);
  const model = screen.getByLabelText('Background model');
  expect(model.querySelector('option[value="model-fallback"]')).toBeNull();
  fireEvent.change(screen.getByLabelText('Background provider'), {
    target: { value: 'claude-code' },
  });
  expect(screen.getByLabelText('Background model')).toHaveValue('model-fallback');
  fireEvent.change(screen.getByLabelText('Background model effort'), { target: { value: 'low' } });
  expect(screen.getByLabelText('Background model effort')).toHaveValue('low');
});

it('keeps Grok native access explicit and independent of foreground full access', () => {
  const snapshot = jest.fn();
  render(<Harness snapshot={snapshot} />);
  expect(screen.queryByLabelText('Background Grok native access')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Background provider'), {
    target: { value: 'grok-build' },
  });
  expect(screen.getByLabelText('Background Grok native access')).toHaveValue('ask');
  fireEvent.change(screen.getByLabelText('Background Grok native access'), {
    target: { value: 'full' },
  });
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[0][0].glasshive_options).toMatchObject({
    access: 'full',
    orchestration: { worker_access: 'full', worker_model: 'model-grok' },
  });
});

it('does not offer full background native access when the existing provider policy forbids it', () => {
  render(<Harness snapshot={jest.fn()} restricted />);
  fireEvent.change(screen.getByLabelText('Background provider'), {
    target: { value: 'grok-build' },
  });
  expect(
    screen.getByLabelText('Background Grok native access').querySelector('option[value="full"]'),
  ).toBeNull();
});

it('clears the unused full setting when the final Grok route is changed', () => {
  const snapshot = jest.fn();
  render(<Harness snapshot={snapshot} />);
  fireEvent.change(screen.getByLabelText('Background provider'), {
    target: { value: 'grok-build' },
  });
  fireEvent.change(screen.getByLabelText('Background Grok native access'), {
    target: { value: 'full' },
  });
  fireEvent.change(screen.getByLabelText('Background provider'), {
    target: { value: 'codex-cli' },
  });
  expect(screen.queryByLabelText('Background Grok native access')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Save snapshot'));
  expect(snapshot.mock.calls[0][0].glasshive_options.orchestration.worker_access).toBe('ask');
});
it('shows a retained unused full setting so the owner can clear it', () => {
  render(<Harness snapshot={jest.fn()} nativeAccess="full" />);
  expect(screen.getByLabelText('Background Grok native access')).toHaveValue('full');
  expect(screen.getByText(/No Grok background route is selected/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Background Grok native access'), {
    target: { value: 'ask' },
  });
  expect(screen.queryByLabelText('Background Grok native access')).not.toBeInTheDocument();
});

it('retains disallowed saved full access visibly until the owner clears it', () => {
  render(<Harness snapshot={jest.fn()} nativeAccess="full" restricted />);
  const field = screen.getByLabelText('Background Grok native access');
  expect(field).toHaveValue('full');
  expect(field.querySelector('option[value="full"]')).toBeDisabled();
  fireEvent.change(field, { target: { value: 'ask' } });
  expect(screen.queryByLabelText('Background Grok native access')).not.toBeInTheDocument();
});

it('keeps explicit full access while the fallback still declares Grok', () => {
  render(<Harness snapshot={jest.fn()} />);
  fireEvent.change(screen.getByLabelText('Background provider'), {
    target: { value: 'grok-build' },
  });
  fireEvent.change(screen.getByLabelText('Background fallback provider'), {
    target: { value: 'grok-build' },
  });
  fireEvent.change(screen.getByLabelText('Background Grok native access'), {
    target: { value: 'full' },
  });
  fireEvent.change(screen.getByLabelText('Background provider'), {
    target: { value: 'codex-cli' },
  });
  expect(screen.getByLabelText('Background Grok native access')).toHaveValue('full');
  fireEvent.change(screen.getByLabelText('Background fallback provider'), {
    target: { value: 'claude-code' },
  });
  expect(screen.queryByLabelText('Background Grok native access')).not.toBeInTheDocument();
});
