import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { FeelingTrailEntry } from 'librechat-data-provider';
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
  levels: (words as string[]).map((word, index) => ({
    id: `level_${index}`,
    min: index * 20,
    max: index === 4 ? 100 : index * 20 + 19,
    word,
    instruction: `${name} ${word} felt cause.`,
  })),
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
      rangePromptOverrides: {},
      rangePromptOverrideCount: 0,
      activeRangePromptOverrideCount: 0,
      activeRangePromptOverrideChars: 0,
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
      trail: [] as FeelingTrailEntry[],
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
    expect(
      screen
        .getAllByRole('button', { pressed: false })
        .filter((button) => button.getAttribute('aria-label')?.startsWith('Select ')),
    ).toHaveLength(8);
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

  test('keeps live state evidence in the main workspace and range shaping in the inspector', async () => {
    const user = userEvent.setup();
    mockQueryData = response(true);
    mockQueryData.state.rangePromptOverrides = {
      play: { level_4: 'Everything in me wants to turn this into a ridiculous game.' },
    };
    mockQueryData.state.rangePromptOverrideCount = 1;
    renderView();

    const capsule = screen.getByRole('heading', { name: 'What Viv feels' });
    const trail = screen.getByRole('heading', { name: 'Reaction trail' });
    expect(capsule.closest('.feelings-primary')).not.toBeNull();
    expect(trail.closest('.feelings-primary')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /Select Play:/ }));
    await user.click(screen.getByRole('tab', { name: /80–100.*exuberant/i }));
    expect(screen.getByText('Play exuberant felt cause.')).toBeInTheDocument();
    const addition = screen.getByLabelText('Your added feeling for exuberant');
    expect(addition).toHaveValue('Everything in me wants to turn this into a ridiculous game.');
    await user.clear(addition);
    await user.type(addition, 'I cannot keep a straight face.');
    await user.click(screen.getByRole('button', { name: 'Save range feeling' }));

    await waitFor(() =>
      expect(mockMutateBand).toHaveBeenCalledWith({
        bandId: 'play',
        data: {
          expectedVersion: 4,
          rangePromptOverride: {
            levelId: 'level_4',
            instruction: 'I cannot keep a straight face.',
          },
        },
      }),
    );
  });

  test('exposes range tabs and side sliders as complete keyboard-readable controls', async () => {
    const user = userEvent.setup();
    mockQueryData = response(true);
    mockQueryData.state.bands.play.current = 88;
    mockQueryData.state.rangePromptOverrides = {
      play: { level_4: 'A custom exuberant pull.' },
    };
    renderView();

    await user.click(screen.getByRole('button', { name: /Select Play:/ }));
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    const activeCustomizedTab = screen.getByRole('tab', { name: /80–100.*exuberant/i });
    expect(activeCustomizedTab).toHaveAttribute('aria-selected', 'true');
    expect(activeCustomizedTab).toHaveTextContent('NOW');
    expect(activeCustomizedTab).toHaveTextContent('CUSTOM');

    fireEvent.keyDown(activeCustomizedTab, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: /60–79.*mischievous/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    expect(screen.getByRole('slider', { name: 'Current feeling' })).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('exuberant'),
    );
    expect(screen.getByRole('slider', { name: 'Nature / resting point' })).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('serious to playful'),
    );
  });

  test('commits sidebar keyboard changes only for range adjustment keys', async () => {
    mockQueryData = response(true);
    renderView();
    const current = screen.getByRole('slider', { name: 'Current feeling' });

    fireEvent.keyUp(current, { key: 'Tab' });
    expect(mockMutateBand).not.toHaveBeenCalled();

    fireEvent.change(current, { target: { value: '69' } });
    fireEvent.keyUp(current, { key: 'ArrowRight' });
    await waitFor(() => expect(mockMutateBand).toHaveBeenCalledTimes(1));
  });

  test('restores a customized range without changing the band level', async () => {
    const user = userEvent.setup();
    mockQueryData = response(true);
    mockQueryData.state.rangePromptOverrides = {
      play: { level_4: 'Custom high play.' },
    };
    renderView();

    await user.click(screen.getByRole('button', { name: /Select Play:/ }));
    await user.click(screen.getByRole('tab', { name: /80–100.*exuberant/i }));
    await user.click(screen.getByRole('button', { name: 'Restore default range feeling' }));

    await waitFor(() =>
      expect(mockMutateBand).toHaveBeenCalledWith({
        bandId: 'play',
        data: {
          expectedVersion: 4,
          rangePromptOverride: { levelId: 'level_4', instruction: null },
        },
      }),
    );
  });

  test('preserves an unsaved range draft across a live polling refresh', async () => {
    const user = userEvent.setup();
    mockQueryData = response(true);
    const view = renderView();

    await user.click(screen.getByRole('button', { name: /Select Play:/ }));
    await user.click(screen.getByRole('tab', { name: /80–100.*exuberant/i }));
    const addition = screen.getByLabelText('Your added feeling for exuberant');
    await user.type(addition, 'A still-unsaved felt pull.');

    mockQueryData = response(true);
    mockQueryData.state.bands.energy.current = 59;
    view.rerender(
      <MemoryRouter initialEntries={['/feelings']}>
        <FeelingsView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(addition).toHaveValue('A still-unsaved felt pull.'));
    expect(mockMutateBand).not.toHaveBeenCalled();
  });

  test('keeps the edited range and draft when a live reaction moves the selected band', async () => {
    const user = userEvent.setup();
    mockQueryData = response(true);
    mockQueryData.state.bands.play.current = 88;
    const view = renderView();

    await user.click(screen.getByRole('button', { name: /Select Play:/ }));
    await user.click(screen.getByRole('tab', { name: /60–79.*mischievous/i }));
    const addition = screen.getByLabelText('Your added feeling for mischievous');
    await user.type(addition, 'Keep this unfinished thought intact.');

    mockQueryData = response(true);
    mockQueryData.state.bands.play.current = 35;
    view.rerender(
      <MemoryRouter initialEntries={['/feelings']}>
        <FeelingsView />
      </MemoryRouter>,
    );

    await waitFor(() => expect(addition).toHaveValue('Keep this unfinished thought intact.'));
    expect(screen.getByRole('tab', { name: /60–79.*mischievous/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /20–39.*light/i })).toHaveTextContent('NOW');
    expect(mockMutateBand).not.toHaveBeenCalled();
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
