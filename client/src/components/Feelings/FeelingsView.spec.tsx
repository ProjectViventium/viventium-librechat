import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import FeelingsView from './FeelingsView';

const mockMutateProfile = jest.fn();
const mockMutateBand = jest.fn();
const mockMutateReset = jest.fn();
const mockMutateDelete = jest.fn();
const mockRefetch = jest.fn();

const definitions = [
  ['energy', 'Energy', 56, 240, ['depleted', 'subdued', 'steady', 'energized', 'electric']],
  ['mood', 'Mood', 58, 360, ['deeply sad', 'low', 'okay', 'happy', 'radiant']],
  [
    'drive',
    'Drive',
    62,
    480,
    ['disengaged', 'unhurried', 'purposeful', 'driven', 'fiercely determined'],
  ],
  ['curiosity', 'Curiosity', 66, 45, ['uninterested', 'open', 'curious', 'fascinated', 'absorbed']],
  ['vigilance', 'Vigilance', 68, 20, ['at ease', 'aware', 'watchful', 'on guard', 'highly alert']],
  [
    'care',
    'Care',
    74,
    1440,
    ['detached', 'receptive', 'caring', 'deeply caring', 'intensely caring'],
  ],
  [
    'connection',
    'Connection',
    52,
    480,
    [
      'self-contained',
      'open',
      'drawn to connection',
      'wanting closeness',
      'strongly drawn to connection',
    ],
  ],
  [
    'openness',
    'Openness',
    55,
    180,
    ['closed off', 'guarded', 'contained', 'emotionally open', 'fully expressive'],
  ],
  ['play', 'Play', 48, 90, ['serious', 'light', 'playful', 'mischievous', 'exuberant']],
].map(([id, name, baseline, halfLifeMinutes, words]) => ({
  id,
  name,
  promptLabel: String(id),
  description: `${name} description.`,
  color: '#7bf0ca',
  lowLabel:
    id === 'energy'
      ? 'tired'
      : id === 'mood'
        ? 'sad'
        : id === 'openness'
          ? 'guarded'
          : id === 'drive'
            ? 'unmotivated'
            : String((words as string[])[0]),
  highLabel:
    id === 'energy'
      ? 'energetic'
      : id === 'drive'
        ? 'determined'
        : id === 'care'
          ? 'deeply caring'
          : id === 'connection'
            ? 'wanting closeness'
            : id === 'play'
              ? 'playful'
              : id === 'mood'
                ? 'happy'
                : id === 'openness'
                  ? 'fully expressive'
                  : String((words as string[])[4]),
  baseline,
  halfLifeMinutes,
  words,
}));

function response(enabled = false) {
  const bands = Object.fromEntries(
    definitions.map((definition) => [
      definition.id,
      {
        baseline: definition.baseline,
        current: definition.baseline,
        halfLifeMinutes: definition.halfLifeMinutes,
        enabled: true,
        updatedAt: '2026-07-09T12:00:00.000Z',
      },
    ]),
  );
  return {
    definitions,
    config: {
      available: true,
      agentScope: 'all_agents',
      reaction: {
        defaultInstruction:
          'React to what genuinely moves Viventium. Prefer small natural changes. Move only the feelings the moment actually touches, and leave nature unchanged.',
        activationMode: 'always',
        provider: 'openai',
        model: 'gpt-5.6-terra',
        useResponsesApi: true,
        reasoningEffort: 'none',
        fast: true,
        serviceTier: 'priority',
        fallbackProvider: 'anthropic',
        fallbackModel: 'claude-opus-4-8',
      },
    },
    state: {
      available: true,
      enabled,
      agentScope: 'all_agents',
      version: 4,
      asOf: '2026-07-09T12:00:00.000Z',
      bands,
      capsule: enabled
        ? '<viventium_feeling_state>\nYou, Viventium, are a being, and right now you are actually feeling this. Let it move naturally through how you think, speak, and act:\nenergy: steady\n</viventium_feeling_state>'
        : '',
      snapshotHash: 'snapshot-4',
      reactionInstruction:
        'React to what genuinely moves Viventium. Prefer small natural changes. Move only the feelings the moment actually touches, and leave nature unchanged.',
      reactionActivationMode: 'always',
      innerState: enabled
        ? {
            text: 'I want to stay close and follow what still feels unresolved.',
            generatedAt: '2026-07-09T12:00:00.000Z',
          }
        : null,
      trail: [],
      reactionHealth: {
        status: 'healthy',
        lastDurationMs: 312,
        requestedModel: 'gpt-5.6-terra',
        requestedServiceTier: 'priority',
        lastUsedProvider: 'openai',
        lastUsedModel: 'gpt-5.6-terra',
        lastUsedServiceTier: 'priority',
        lastFallbackUsed: false,
      },
    },
  };
}

let mockQueryData = response(false);

jest.mock('~/data-provider', () => ({
  useFeelingsQuery: () => ({
    data: mockQueryData,
    isLoading: false,
    isError: false,
    refetch: mockRefetch,
  }),
  useUpdateFeelingsProfileMutation: () => ({ mutateAsync: mockMutateProfile, isLoading: false }),
  useUpdateFeelingBandMutation: () => ({ mutateAsync: mockMutateBand, isLoading: false }),
  useResetFeelingsMutation: () => ({ mutateAsync: mockMutateReset, isLoading: false }),
  useDeleteFeelingsMutation: () => ({ mutateAsync: mockMutateDelete, isLoading: false }),
}));

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/feelings']}>
      <FeelingsView />
    </MemoryRouter>,
  );
}

describe('FeelingsView', () => {
  beforeEach(() => {
    mockQueryData = response(false);
    mockMutateProfile.mockResolvedValue(mockQueryData);
    mockMutateBand.mockResolvedValue(mockQueryData);
    mockMutateReset.mockResolvedValue(mockQueryData);
    mockMutateDelete.mockResolvedValue({ deleted: true });
  });

  test('renders the locked off-state instrument with no prompt capsule', () => {
    renderView();
    expect(screen.getByRole('heading', { name: 'Feeling spectrum' })).toBeInTheDocument();
    expect(screen.getByText('Feelings are off')).toBeInTheDocument();
    expect(
      screen.getByText('No feeling-state block exists while Feelings are off.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(8);
  });

  test('enables Feelings with the current version and opens the configured Fast cortex', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('switch', { name: 'Enable Feelings' }));
    expect(mockMutateProfile).toHaveBeenCalledWith({ expectedVersion: 4, enabled: true });

    await user.click(screen.getByRole('button', { name: 'Reaction Cortex' }));
    expect(screen.getByRole('dialog', { name: 'Emotional Reaction Cortex' })).toBeVisible();
    expect(screen.getByText(/Primary: gpt-5\.6-terra · Fast/)).toBeInTheDocument();
    expect(screen.getByText(/Fallback: claude-opus-4-8/)).toBeInTheDocument();
    expect(screen.getByText(/Last route: gpt-5\.6-terra · priority/)).toBeInTheDocument();
    expect(
      (screen.getByLabelText('How should the subconscious react?') as HTMLTextAreaElement).value,
    ).toContain('React to what genuinely moves Viventium');
    expect(screen.getByLabelText('When should it activate?')).toHaveValue('always');
  });

  test('shows the exact embodied capsule and persists manual band control', async () => {
    mockQueryData = response(true);
    renderView();
    expect(screen.getByText(/You, Viventium, are a being/)).toBeInTheDocument();
    expect(
      screen.getByText('I want to stay close and follow what still feels unresolved.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last felt sense/)).toBeInTheDocument();
    const current = screen.getByRole('slider', { name: 'Current feeling' });
    fireEvent.change(current, { target: { value: '80' } });
    fireEvent.pointerUp(current);
    await waitFor(() =>
      expect(mockMutateBand).toHaveBeenCalledWith({
        bandId: 'vigilance',
        data: { expectedVersion: 4, current: 80 },
      }),
    );
  });

  test('makes every lane direction, Current, Nature, and reaction cause explicit', () => {
    mockQueryData = response(true);
    mockQueryData.state.trail = [
      {
        timestamp: '2026-07-09T12:00:01.000Z',
        band: 'play',
        direction: 'up',
        strength: 'clear',
        cause: 'playful_exchange',
        sourceType: 'user_turn',
        before: 48,
        after: 56,
      },
    ];
    renderView();

    expect(screen.getByText('energetic')).toBeInTheDocument();
    expect(screen.getByText('tired')).toBeInTheDocument();
    expect(screen.getAllByText(/NOW/).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/NATURE/).length).toBeGreaterThan(1);
    expect(screen.getByText('Playful exchange')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Energy current feeling' })).toHaveAttribute(
      'aria-valuetext',
      'steady, 56',
    );
    expect(screen.getByRole('slider', { name: 'Energy nature' })).toHaveAttribute(
      'aria-valuenow',
      '56',
    );
    const playTail = screen.getByTestId('feelings-motion-tail-play');
    expect(playTail).toBeInTheDocument();
    expect(playTail.querySelector('.feelings-motion-tail-core')?.getAttribute('d')).toMatch(
      /93 51\.84$/,
    );
    expect(screen.queryByTestId('feelings-motion-tail-energy')).not.toBeInTheDocument();
  });

  test('does not draw a motion tail for a flat typed path', () => {
    mockQueryData = response(true);
    mockQueryData.state.trail = [
      {
        timestamp: '2026-07-09T12:00:01.000Z',
        band: 'play',
        direction: 'up',
        strength: 'slight',
        cause: 'other',
        sourceType: 'user_turn',
        before: 48,
        after: 48,
      },
    ];
    renderView();
    expect(screen.queryByTestId('feelings-motion-tail-play')).not.toBeInTheDocument();
  });

  test('shows a truthful waiting state before the first generated inner-state line', () => {
    mockQueryData = response(true);
    mockQueryData.state.innerState = null;
    renderView();
    expect(
      screen.getByText('The next reaction will put this state into Viv’s own words.'),
    ).toBeInTheDocument();
  });

  test('confirms permanent erase and sends the current version', async () => {
    const user = userEvent.setup();
    const confirm = jest
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderView();
    await user.click(screen.getByRole('button', { name: 'Reaction Cortex' }));
    const erase = screen.getByRole('button', { name: 'Turn off & erase' });

    await user.click(erase);
    expect(mockMutateDelete).not.toHaveBeenCalled();

    await user.click(erase);
    await waitFor(() => expect(mockMutateDelete).toHaveBeenCalledWith(4));
    confirm.mockRestore();
  });
});
