/* eslint-disable i18next/no-literal-string -- Viventium's locked Feelings instrument owns this exact product copy. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, RotateCcw, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import type {
  FeelingBandId,
  FeelingBandDefinition,
  FeelingLevelId,
  FeelingTrailEntry,
  UpdateFeelingBand,
} from 'librechat-data-provider';
import {
  MAX_FEELING_RANGE_PROMPT_CHARS,
  VISIBLE_FEELING_TRAIL_LIMIT,
} from 'librechat-data-provider';
import {
  useDeleteFeelingsMutation,
  useFeelingsQuery,
  useResetFeelingsMutation,
  useUpdateFeelingBandMutation,
  useUpdateFeelingsProfileMutation,
} from '~/data-provider';
import './feelings.css';

const FUTURE_BANDS = [
  'Distress / pain',
  'Anger / assertion',
  'Disgust / aversion',
  'Trust / security',
  'Guilt / shame',
  'Confidence / control',
];

const RETURN_SPEEDS = [
  { value: 10, label: 'Very fast · 10 min' },
  { value: 20, label: 'Fast · 20 min' },
  { value: 45, label: 'Medium · 45 min' },
  { value: 90, label: 'Slow · 90 min' },
  { value: 240, label: 'Very slow · 4 hr' },
  { value: 480, label: 'Long · 8 hr' },
  { value: 1440, label: 'Enduring · 24 hr' },
];

const REACTION_CAUSE_LABELS: Record<string, string> = {
  playful_exchange: 'Playful exchange',
  connection_bid: 'Pull toward connection',
  care_signal: 'A moment calling for care',
  progress: 'Progress',
  setback: 'A setback',
  new_information: 'Something new',
  uncertainty: 'Uncertainty',
  risk_or_boundary: 'Risk or boundary',
  fatigue: 'Strain or fatigue',
  conflict: 'Friction or conflict',
  praise: 'Recognition',
  loss: 'Loss',
  surprise: 'Surprise',
  other: 'The moment',
  manual_adjustment: 'You adjusted it',
  reset_to_nature: 'Reset to Nature',
};

const RANGE_COMMIT_KEYS = new Set([
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'ArrowLeft',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

function feelingWord(definition: FeelingBandDefinition, value: number) {
  return feelingLevel(definition, value).word;
}

function feelingLevel(definition: FeelingBandDefinition, value: number) {
  return definition.levels[Math.min(4, Math.floor(Math.max(0, Math.min(100, value)) / 20))];
}

function halfLifeLabel(minutes: number) {
  if (minutes < 60) return `${minutes} min half-life`;
  if (minutes % 1440 === 0) return `${minutes / 1440} day half-life`;
  if (minutes % 60 === 0) return `${minutes / 60} hr half-life`;
  return `${minutes} min half-life`;
}

function deltaLabel(current: number, baseline: number) {
  const delta = Math.round(current - baseline);
  if (Math.abs(delta) < 1) return 'at nature';
  return `${Math.abs(delta)} ${delta > 0 ? 'above' : 'below'} nature`;
}

function trailVerb(direction: 'up' | 'down', strength: 'slight' | 'clear' | 'strong') {
  const strengthWord =
    strength === 'slight' ? 'slightly' : strength === 'clear' ? 'clearly' : 'strongly';
  return `${direction === 'up' ? 'rose' : 'fell'} ${strengthWord}`;
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function innerStateAge(generatedAt: string) {
  const elapsedMs = Math.max(0, Date.now() - new Date(generatedAt).getTime());
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1) return 'formed just now';
  if (minutes < 60) return `formed ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `formed ${hours}h ago`;
  return `formed ${Math.floor(hours / 24)}d ago`;
}

function motionValues(trail: FeelingTrailEntry[], bandId: FeelingBandId, current: number) {
  const entries = trail.filter((entry) => entry.band === bandId).slice(-12);
  if (entries.length === 0) return [];
  const values = [entries[0].before, ...entries.map((entry) => entry.after)];
  if (Math.abs(values[values.length - 1] - current) >= 0.5) values.push(current);
  const distinct = values.filter(
    (value, index) => index === 0 || Math.abs(value - values[index - 1]) >= 0.25,
  );
  return distinct.length >= 2 ? distinct.slice(-12) : [];
}

function motionPath(values: number[]) {
  if (values.length < 2) return '';
  const points = values.map((value, index) => ({
    x: 7 + (index / (values.length - 1)) * 86,
    y: Number((96 - clamp(value) * 0.92).toFixed(2)),
  }));
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const middle = (previous.x + point.x) / 2;
    const bend = index % 2 === 0 ? 2.8 : -2.8;
    return `${path} C ${middle - 4} ${previous.y + bend}, ${middle + 4} ${point.y - bend}, ${point.x} ${point.y}`;
  }, `M ${points[0].x} ${points[0].y}`);
}

function FeelingMotionTrail({
  trail,
  bandId,
  current,
}: {
  trail: FeelingTrailEntry[];
  bandId: FeelingBandId;
  current: number;
}) {
  const path = motionPath(motionValues(trail, bandId, current));
  if (!path) return null;
  const gradientId = `feelings-tail-${bandId}`;
  return (
    <svg
      className="feelings-motion-tail"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      data-testid={`feelings-motion-tail-${bandId}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--band-color)" stopOpacity="0" />
          <stop offset="0.46" stopColor="var(--band-color)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--band-color)" stopOpacity="0.95" />
        </linearGradient>
      </defs>
      <path className="feelings-motion-tail-glow" d={path} stroke={`url(#${gradientId})`} />
      <path className="feelings-motion-tail-core" d={path} stroke={`url(#${gradientId})`} />
    </svg>
  );
}

export default function FeelingsView() {
  const navigate = useNavigate();
  const feelings = useFeelingsQuery();
  const profileMutation = useUpdateFeelingsProfileMutation();
  const bandMutation = useUpdateFeelingBandMutation();
  const resetMutation = useResetFeelingsMutation();
  const deleteMutation = useDeleteFeelingsMutation();
  const [selectedId, setSelectedId] = useState<FeelingBandId>('vigilance');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reactionInstruction, setReactionInstruction] = useState('');
  const [activationMode, setActivationMode] = useState<'always' | 'classified' | 'disabled'>(
    'always',
  );
  const [draftCurrent, setDraftCurrent] = useState(0);
  const [draftBaseline, setDraftBaseline] = useState(0);
  const [draftHalfLife, setDraftHalfLife] = useState(20);
  const [selectedRangeLevelId, setSelectedRangeLevelId] = useState<FeelingLevelId>('level_2');
  const [rangePromptDraft, setRangePromptDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [laneDrafts, setLaneDrafts] = useState<
    Partial<Record<FeelingBandId, { current?: number; baseline?: number }>>
  >({});
  const [reactingBandIds, setReactingBandIds] = useState<FeelingBandId[]>([]);
  const [draggingBandId, setDraggingBandId] = useState<FeelingBandId | null>(null);

  const payload = feelings.data;
  const state = payload?.state;
  const definitions = useMemo(() => payload?.definitions ?? [], [payload?.definitions]);
  const definition = definitions.find((band) => band.id === selectedId) ?? definitions[0];
  const selectedBand = definition ? state?.bands[definition.id] : undefined;
  const stateRef = useRef(state);
  const draggingBandIdRef = useRef(draggingBandId);
  const trailEffectMountedRef = useRef(false);
  const lastAnimatedTrailRef = useRef('');
  const rangePromptDraftRef = useRef(rangePromptDraft);
  const rangePromptSyncRef = useRef({ key: '', saved: '' });
  const mutationPending =
    profileMutation.isLoading ||
    bandMutation.isLoading ||
    resetMutation.isLoading ||
    deleteMutation.isLoading;
  draggingBandIdRef.current = draggingBandId;
  rangePromptDraftRef.current = rangePromptDraft;
  const bandSyncSignature = state
    ? definitions
        .map((band) => {
          const value = state.bands[band.id];
          return `${band.id}:${value.current}:${value.baseline}:${value.halfLifeMinutes}:${value.enabled}`;
        })
        .join('|')
    : '';
  const latestTrailEntry = state?.trail[state.trail.length - 1];
  const latestTrailKey = latestTrailEntry
    ? `${latestTrailEntry.timestamp}:${latestTrailEntry.band}:${latestTrailEntry.after}:${latestTrailEntry.sourceType}`
    : '';
  const selectedSavedRangePrompt =
    definition && state
      ? (state.rangePromptOverrides[definition.id]?.[selectedRangeLevelId] ?? '')
      : '';
  const rangePromptContextKey = definition ? `${definition.id}:${selectedRangeLevelId}` : '';

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!bandSyncSignature || draggingBandIdRef.current) return;
    setLaneDrafts({});
  }, [bandSyncSignature]);

  useEffect(() => {
    if (!trailEffectMountedRef.current) {
      trailEffectMountedRef.current = true;
      lastAnimatedTrailRef.current = latestTrailKey;
      return;
    }
    if (!latestTrailKey || latestTrailKey === lastAnimatedTrailRef.current) return;
    lastAnimatedTrailRef.current = latestTrailKey;
    const latest = stateRef.current?.trail[stateRef.current.trail.length - 1];
    if (!latest || latest.sourceType !== 'user_turn') return;
    const timestamp = String(latest.timestamp);
    const changed = Array.from(
      new Set(
        (stateRef.current?.trail ?? [])
          .filter(
            (entry) => entry.sourceType === 'user_turn' && String(entry.timestamp) === timestamp,
          )
          .map((entry) => entry.band),
      ),
    );
    if (!changed.length) return;
    setReactingBandIds(changed);
    const timeout = window.setTimeout(() => setReactingBandIds([]), 1500);
    return () => window.clearTimeout(timeout);
  }, [latestTrailKey]);

  useEffect(() => {
    if (!selectedBand) return;
    if (draggingBandIdRef.current === selectedId) return;
    setDraftCurrent(Math.round(selectedBand.current));
    setDraftBaseline(Math.round(selectedBand.baseline));
    setDraftHalfLife(selectedBand.halfLifeMinutes);
  }, [
    definition?.id,
    selectedBand?.baseline,
    selectedBand?.current,
    selectedBand?.halfLifeMinutes,
    selectedId,
  ]);

  useEffect(() => {
    if (!definition || !selectedBand) return;
    setSelectedRangeLevelId(feelingLevel(definition, selectedBand.current).id);
  }, [definition?.id]);

  useEffect(() => {
    if (!definition || !state) return;
    const previous = rangePromptSyncRef.current;
    const contextChanged = previous.key !== rangePromptContextKey;
    const hasUnsavedLocalEdit = rangePromptDraftRef.current !== previous.saved;
    if (contextChanged || !hasUnsavedLocalEdit) {
      setRangePromptDraft(selectedSavedRangePrompt);
    }
    rangePromptSyncRef.current = {
      key: rangePromptContextKey,
      saved: selectedSavedRangePrompt,
    };
  }, [definition?.id, rangePromptContextKey, selectedSavedRangePrompt, state]);

  useEffect(() => {
    if (!state) return;
    setReactionInstruction(
      state.reactionInstruction || feelings.data?.config.reaction.defaultInstruction || '',
    );
    setActivationMode(state.reactionActivationMode);
  }, [feelings.data?.config.reaction.defaultInstruction, state]);

  useEffect(() => {
    if (!drawerOpen) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [drawerOpen]);

  const activeBands = useMemo(
    () => definitions.filter((band) => state?.bands[band.id]?.enabled).length,
    [definitions, state?.bands],
  );

  async function runMutation(task: () => Promise<unknown>, success: string) {
    setNotice('');
    try {
      await task();
      setNotice(success);
    } catch (_error) {
      setNotice('Feelings changed elsewhere. The latest state has been reloaded.');
      await feelings.refetch();
    }
  }

  function updateProfile(update: {
    enabled?: boolean;
    reactionInstruction?: string;
    reactionActivationMode?: 'always' | 'classified' | 'disabled';
  }) {
    if (!state) return Promise.resolve();
    return profileMutation.mutateAsync({ expectedVersion: state.version, ...update });
  }

  function updateBandById(
    bandId: FeelingBandId,
    update: Omit<UpdateFeelingBand, 'expectedVersion'>,
  ) {
    const latestState = stateRef.current;
    if (!latestState) return Promise.resolve();
    return bandMutation.mutateAsync({
      bandId,
      data: { expectedVersion: latestState.version, ...update },
    });
  }

  function updateBand(update: Omit<UpdateFeelingBand, 'expectedVersion'>) {
    if (!definition) return Promise.resolve();
    return updateBandById(definition.id, update);
  }

  function previewLaneValue(bandId: FeelingBandId, field: 'current' | 'baseline', value: number) {
    const next = clamp(value);
    setLaneDrafts((current) => ({
      ...current,
      [bandId]: { ...current[bandId], [field]: next },
    }));
    if (bandId === selectedId) {
      if (field === 'current') setDraftCurrent(next);
      else setDraftBaseline(next);
    }
    return next;
  }

  function beginLaneDrag(
    event: React.PointerEvent<HTMLButtonElement>,
    bandId: FeelingBandId,
    field: 'current' | 'baseline',
  ) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(bandId);
    setDraggingBandId(bandId);
    const track = event.currentTarget.closest('.feelings-track');
    if (!(track instanceof HTMLElement)) return;
    const rect = track.getBoundingClientRect();
    let nextValue = previewLaneValue(
      bandId,
      field,
      ((rect.bottom - event.clientY) / rect.height) * 100,
    );
    const onMove = (moveEvent: PointerEvent) => {
      nextValue = previewLaneValue(
        bandId,
        field,
        ((rect.bottom - moveEvent.clientY) / rect.height) * 100,
      );
    };
    const clearDragListeners = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
    };
    const onUp = () => {
      clearDragListeners();
      setDraggingBandId(null);
      const bandName = definitions.find((item) => item.id === bandId)?.name ?? bandId;
      void runMutation(
        () => updateBandById(bandId, { [field]: nextValue }),
        field === 'current' ? `${bandName} moved.` : `${bandName} nature changed.`,
      );
    };
    const onCancel = () => {
      clearDragListeners();
      setDraggingBandId(null);
      setLaneDrafts((current) => {
        const next = { ...current };
        delete next[bandId];
        return next;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
    window.addEventListener('blur', onCancel, { once: true });
  }

  function moveLaneWithKeyboard(
    event: React.KeyboardEvent<HTMLButtonElement>,
    bandId: FeelingBandId,
    field: 'current' | 'baseline',
    value: number,
  ) {
    const directions: Record<string, number> = {
      ArrowUp: event.shiftKey ? 5 : 1,
      ArrowRight: event.shiftKey ? 5 : 1,
      ArrowDown: event.shiftKey ? -5 : -1,
      ArrowLeft: event.shiftKey ? -5 : -1,
    };
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? 100 : value + (directions[event.key] ?? 0);
    if (!(event.key in directions) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(bandId);
    const preview = previewLaneValue(bandId, field, next);
    const bandName = definitions.find((item) => item.id === bandId)?.name ?? bandId;
    void runMutation(
      () => updateBandById(bandId, { [field]: preview }),
      field === 'current' ? `${bandName} moved.` : `${bandName} nature changed.`,
    );
  }

  if (feelings.isLoading) {
    return (
      <main className="feelings-view feelings-loading" aria-busy="true">
        <div className="feelings-orb" />
        <span>Reading Viventium’s inner state…</span>
      </main>
    );
  }

  if (feelings.isError || !payload || !state || !definition || !selectedBand) {
    return (
      <main className="feelings-view feelings-loading">
        <strong>Feelings could not be loaded.</strong>
        <button type="button" onClick={() => feelings.refetch()}>
          Try again
        </button>
      </main>
    );
  }

  if (!payload.config.available || !state.available) {
    return (
      <main className="feelings-view feelings-loading">
        <strong>Feelings are not available in this Viventium configuration.</strong>
        <button type="button" onClick={() => navigate('/c/new')}>
          Return to chat
        </button>
      </main>
    );
  }

  const selectedColorStyle = { '--selected-color': definition.color } as React.CSSProperties;
  const activeLevel = feelingLevel(definition, draftCurrent);
  const selectedRangeLevel =
    definition.levels.find((level) => level.id === selectedRangeLevelId) ?? activeLevel;
  const savedRangePrompt = state.rangePromptOverrides[definition.id]?.[selectedRangeLevel.id] ?? '';
  const health = state.reactionHealth;
  const healthLabel =
    health.status === 'running'
      ? 'Reacting now'
      : health.status === 'healthy'
        ? `Ready · ${health.lastDurationMs ?? 0} ms last reaction`
        : health.status === 'degraded'
          ? `Needs attention · ${health.lastErrorClass || 'reaction failed'}${health.lastErrorDetail ? ` · ${health.lastErrorDetail}` : ''}`
          : health.status === 'skipped'
            ? `Ready · last skipped (${health.lastSkipReason || 'not needed'})`
            : 'Ready · waiting for the first reaction';

  return (
    <main className="feelings-view" style={selectedColorStyle}>
      <div className="feelings-shell">
        <header className="feelings-topbar">
          <div className="feelings-brand">
            <button
              className="feelings-back"
              type="button"
              onClick={() => navigate('/c/new')}
              aria-label="Back to chat"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="feelings-brand-mark" aria-hidden="true" />
            <div>
              <p>Viventium · Feelings</p>
              <span>live inner state</span>
            </div>
          </div>
          <div className="feelings-actions">
            <button className="feelings-utility" type="button" onClick={() => setDrawerOpen(true)}>
              Reaction Cortex
            </button>
            <button
              className="feelings-utility reset-label"
              type="button"
              aria-label="Reset state"
              disabled={mutationPending}
              onClick={() =>
                void runMutation(
                  () => resetMutation.mutateAsync(state.version),
                  'Returned every feeling to nature.',
                )
              }
            >
              <RotateCcw size={14} aria-hidden="true" />
              <span>Reset state</span>
            </button>
            <button
              className="feelings-master-toggle"
              type="button"
              role="switch"
              aria-checked={state.enabled}
              disabled={mutationPending}
              onClick={() =>
                void runMutation(
                  () => updateProfile({ enabled: !state.enabled }),
                  state.enabled ? 'Feelings are off.' : 'Feelings are awake.',
                )
              }
            >
              <span>{state.enabled ? 'Feelings on' : 'Enable Feelings'}</span>
              <i className="feelings-switch" aria-hidden="true" />
            </button>
          </div>
        </header>

        {notice && (
          <div className="feelings-notice" role="status">
            {notice}
          </div>
        )}

        <div className="feelings-workspace">
          <section className="feelings-primary" aria-labelledby="feelings-title">
            <div className="feelings-heading">
              <div>
                <p className="feelings-kicker">Inner state</p>
                <h1 id="feelings-title">Feeling spectrum</h1>
                <p>Current feeling is the live signal. Nature is the resting line it returns to.</p>
              </div>
              <div className="feelings-live-readout">
                <span className={health.status === 'degraded' ? 'is-degraded' : ''} />
                {healthLabel}
              </div>
            </div>

            {state.enabled && (
              <section className="feelings-inner-state" aria-live="polite">
                <div>
                  <span>Inner state · in Viv’s own words</span>
                  {state.innerState && (
                    <time dateTime={state.innerState.generatedAt}>
                      Last felt sense · {innerStateAge(state.innerState.generatedAt)}
                    </time>
                  )}
                </div>
                <p>
                  {state.innerState?.text ||
                    'The next reaction will put this state into Viv’s own words.'}
                </p>
              </section>
            )}

            <div className={`feelings-instrument ${state.enabled ? '' : 'is-off'}`}>
              <div className="feelings-heartbeat" aria-hidden="true" />
              <div className="feelings-spectrum" aria-label={`${definitions.length} feeling bands`}>
                {definitions.map((bandDefinition) => {
                  const band = state.bands[bandDefinition.id];
                  const preview = laneDrafts[bandDefinition.id];
                  const current = Math.round(preview?.current ?? band.current);
                  const baseline = Math.round(preview?.baseline ?? band.baseline);
                  const selected = bandDefinition.id === definition.id;
                  const tetherBottom = Math.min(current, baseline);
                  const tetherHeight = Math.abs(current - baseline);
                  return (
                    <article
                      key={bandDefinition.id}
                      className={`feelings-lane ${selected ? 'is-selected' : ''} ${band.enabled ? '' : 'is-muted'} ${reactingBandIds.includes(bandDefinition.id) ? 'is-reacting' : ''} ${draggingBandId === bandDefinition.id ? 'is-dragging' : ''}`}
                      style={{ '--band-color': bandDefinition.color } as React.CSSProperties}
                    >
                      <button
                        className="feelings-lane-select"
                        type="button"
                        onClick={() => setSelectedId(bandDefinition.id)}
                        aria-pressed={selected}
                        aria-label={`Select ${bandDefinition.name}: now ${current}, nature ${baseline}`}
                      >
                        <i className="feelings-band-signal" aria-hidden="true" />
                        <span className="feelings-lane-name">{bandDefinition.name}</span>
                        <span className="feelings-lane-values">
                          <b>NOW {current}</b>
                          <i>NATURE {baseline}</i>
                        </span>
                      </button>
                      <span className="feelings-pole feelings-pole-high">
                        {bandDefinition.highLabel}
                      </span>
                      <div className="feelings-track">
                        <i className="feelings-grid-lines" aria-hidden="true" />
                        <i
                          className="feelings-current-fill"
                          style={{ height: `${current}%` }}
                          aria-hidden="true"
                        />
                        <FeelingMotionTrail
                          trail={state.trail}
                          bandId={bandDefinition.id}
                          current={current}
                        />
                        <i
                          className="feelings-state-tether"
                          style={{ bottom: `${tetherBottom}%`, height: `${tetherHeight}%` }}
                          aria-hidden="true"
                        />
                        <i
                          className="feelings-nature-line"
                          style={{ bottom: `${baseline}%` }}
                          aria-hidden="true"
                        />
                        <button
                          className="feelings-nature-marker"
                          style={{ bottom: `${baseline}%` }}
                          type="button"
                          role="slider"
                          aria-label={`${bandDefinition.name} nature`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={baseline}
                          aria-valuetext={`Nature: ${baseline}, toward ${bandDefinition.highLabel}`}
                          onPointerDown={(event) =>
                            beginLaneDrag(event, bandDefinition.id, 'baseline')
                          }
                          onKeyDown={(event) =>
                            moveLaneWithKeyboard(event, bandDefinition.id, 'baseline', baseline)
                          }
                        >
                          <span>N</span>
                        </button>
                        <button
                          className="feelings-current-marker"
                          style={{ bottom: `${current}%` }}
                          type="button"
                          role="slider"
                          aria-label={`${bandDefinition.name} current feeling`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={current}
                          aria-valuetext={`${feelingWord(bandDefinition, current)}, ${current}`}
                          onPointerDown={(event) =>
                            beginLaneDrag(event, bandDefinition.id, 'current')
                          }
                          onKeyDown={(event) =>
                            moveLaneWithKeyboard(event, bandDefinition.id, 'current', current)
                          }
                        >
                          <b>{current}</b>
                        </button>
                      </div>
                      <span className="feelings-pole feelings-pole-low">
                        {bandDefinition.lowLabel}
                      </span>
                      <div className="feelings-lane-footer">
                        <span className="feelings-word">
                          {band.enabled ? feelingWord(bandDefinition, current) : 'not felt'}
                        </span>
                        <span>{halfLifeLabel(band.halfLifeMinutes).replace(' half-life', '')}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="feelings-legend">
                <div>
                  <span>
                    <i className="legend-current" />
                    Current feeling
                  </span>
                  <span>
                    <i className="legend-nature" />
                    Nature / resting line
                  </span>
                </div>
                <span>Drag either marker · arrows adjust · Shift + arrows moves 5</span>
              </div>
              {!state.enabled && (
                <div className="feelings-off-overlay">
                  <div className="feelings-off-message">
                    <div className="feelings-off-orb" aria-hidden="true" />
                    <strong>Feelings are off</strong>
                    <span>
                      No feeling state exists in Viventium’s prompt while off. The spectrum keeps
                      returning toward nature.
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="feelings-state-details">
              <section className="feelings-capsule" aria-labelledby="capsule-title">
                <div>
                  <h3 id="capsule-title">What Viv feels</h3>
                  <span>
                    {activeBands} of {definitions.length} felt
                  </span>
                </div>
                {state.capsule ? (
                  <pre>{state.capsule}</pre>
                ) : (
                  <p>No feeling-state block exists while Feelings are off.</p>
                )}
              </section>

              <section className="feelings-trail" aria-labelledby="trail-title">
                <div>
                  <div>
                    <h3 id="trail-title">Reaction trail</h3>
                    <p>What moved the state · message text is not stored</p>
                  </div>
                  <span>last 10</span>
                </div>
                <div className="feelings-trail-list">
                  {state.trail.length === 0 && <p>No reactions yet.</p>}
                  {[...state.trail]
                    .slice(-VISIBLE_FEELING_TRAIL_LIMIT)
                    .reverse()
                    .map((entry, index) => {
                      const entryDefinition = definitions.find((band) => band.id === entry.band);
                      return (
                        <div
                          className="feelings-trail-entry"
                          key={`${entry.timestamp}-${entry.band}-${index}`}
                        >
                          <time>
                            {new Date(entry.timestamp).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                          <div>
                            <em>
                              {REACTION_CAUSE_LABELS[entry.cause] ||
                                (entry.sourceType === 'user_turn'
                                  ? 'The user moment'
                                  : 'Manual change')}
                            </em>
                            <strong>
                              {entryDefinition?.name || entry.band}{' '}
                              {trailVerb(entry.direction, entry.strength)}
                            </strong>
                            <span>
                              {Math.round(entry.before)} → {Math.round(entry.after)} ·{' '}
                              {entry.sourceType.replace('_', ' ')}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </section>
            </div>

            <details className="feelings-research">
              <summary>
                <span>Future feeling research · visible here, never injected</span>
                <span>{FUTURE_BANDS.length} inactive bands</span>
              </summary>
              <div>
                {FUTURE_BANDS.map((band) => (
                  <span key={band}>{band}</span>
                ))}
              </div>
            </details>
          </section>

          <aside className="feelings-inspector" aria-label="Selected feeling controls">
            <div className="feelings-inspector-header">
              <div>
                <div className="feelings-selected-signal" aria-hidden="true" />
                <p className="feelings-kicker">Selected feeling</p>
                <h2>{definition.name}</h2>
                <p>{definition.description}</p>
              </div>
              <button
                className="feelings-band-toggle"
                type="button"
                role="switch"
                aria-checked={selectedBand.enabled}
                disabled={mutationPending}
                onClick={() =>
                  void runMutation(
                    () => updateBand({ enabled: !selectedBand.enabled }),
                    selectedBand.enabled
                      ? `${definition.name} is no longer felt.`
                      : `${definition.name} is felt again.`,
                  )
                }
              >
                <span>Felt</span>
                <i className="feelings-switch" aria-hidden="true" />
              </button>
            </div>

            <div className="feelings-felt-readout">
              <div>
                <strong>{feelingWord(definition, draftCurrent)}</strong>
                <span>{deltaLabel(draftCurrent, draftBaseline)}</span>
              </div>
              <div className="feelings-state-compare" aria-label="Current and Nature values">
                <span className="is-current">
                  <i>NOW</i>
                  <b>{draftCurrent}</b>
                </span>
                <span className="is-nature">
                  <i>NATURE</i>
                  <b>{draftBaseline}</b>
                </span>
              </div>
            </div>

            <div className="feelings-control is-current">
              <label htmlFor="feeling-current">
                <span>
                  <i>NOW</i> Current feeling
                </span>
                <output>{draftCurrent}</output>
              </label>
              <input
                id="feeling-current"
                aria-label="Current feeling"
                aria-valuetext={`${feelingWord(definition, draftCurrent)}, ${draftCurrent}; ${definition.lowLabel} to ${definition.highLabel}`}
                type="range"
                min="0"
                max="100"
                value={draftCurrent}
                disabled={mutationPending}
                onChange={(event) => setDraftCurrent(Number(event.target.value))}
                onPointerUp={() =>
                  void runMutation(
                    () => updateBand({ current: draftCurrent }),
                    `${definition.name} moved.`,
                  )
                }
                onKeyUp={(event) => {
                  if (!RANGE_COMMIT_KEYS.has(event.key)) return;
                  void runMutation(
                    () => updateBand({ current: draftCurrent }),
                    `${definition.name} moved.`,
                  );
                }}
              />
              <div className="feelings-control-poles">
                <span>{definition.lowLabel}</span>
                <span>{definition.highLabel}</span>
              </div>
            </div>

            <div className="feelings-control is-nature">
              <label htmlFor="feeling-nature">
                <span>
                  <i>NATURE</i> Resting point
                </span>
                <output>{draftBaseline}</output>
              </label>
              <input
                id="feeling-nature"
                aria-label="Nature / resting point"
                aria-valuetext={`${feelingWord(definition, draftBaseline)}, ${draftBaseline}; ${definition.lowLabel} to ${definition.highLabel}`}
                className="is-nature"
                type="range"
                min="0"
                max="100"
                value={draftBaseline}
                disabled={mutationPending}
                onChange={(event) => setDraftBaseline(Number(event.target.value))}
                onPointerUp={() =>
                  void runMutation(
                    () => updateBand({ baseline: draftBaseline }),
                    `${definition.name} nature changed.`,
                  )
                }
                onKeyUp={(event) => {
                  if (!RANGE_COMMIT_KEYS.has(event.key)) return;
                  void runMutation(
                    () => updateBand({ baseline: draftBaseline }),
                    `${definition.name} nature changed.`,
                  );
                }}
              />
              <div className="feelings-control-poles">
                <span>{definition.lowLabel}</span>
                <span>{definition.highLabel}</span>
              </div>
            </div>

            <div className="feelings-control">
              <label htmlFor="feeling-return">
                <span>Return speed</span>
                <output>{halfLifeLabel(draftHalfLife)}</output>
              </label>
              <select
                id="feeling-return"
                aria-label="Return speed"
                value={draftHalfLife}
                disabled={mutationPending}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setDraftHalfLife(next);
                  void runMutation(
                    () => updateBand({ halfLifeMinutes: next }),
                    `${definition.name} return speed changed.`,
                  );
                }}
              >
                {!RETURN_SPEEDS.some((speed) => speed.value === draftHalfLife) && (
                  <option value={draftHalfLife}>{halfLifeLabel(draftHalfLife)}</option>
                )}
                {RETURN_SPEEDS.map((speed) => (
                  <option key={speed.value} value={speed.value}>
                    {speed.label}
                  </option>
                ))}
              </select>
            </div>

            <section className="feelings-range-editor" aria-labelledby="range-editor-title">
              <div className="feelings-range-heading">
                <div>
                  <h3 id="range-editor-title">Feeling ranges</h3>
                  <p>Shape how each depth is felt. Only the current range reaches Viv.</p>
                </div>
                <span>{state.rangePromptOverrideCount} customized</span>
              </div>
              <div
                className="feelings-range-tabs"
                role="tablist"
                aria-label={`${definition.name} feeling ranges`}
              >
                {definition.levels.map((level, levelIndex) => {
                  const isActive = level.id === activeLevel.id;
                  const isSelected = level.id === selectedRangeLevel.id;
                  const isCustomized = Boolean(
                    state.rangePromptOverrides[definition.id]?.[level.id],
                  );
                  return (
                    <button
                      key={level.id}
                      id={`feeling-range-tab-${definition.id}-${level.id}`}
                      type="button"
                      role="tab"
                      className={`${isSelected ? 'is-selected' : ''} ${isActive ? 'is-active' : ''}`}
                      aria-selected={isSelected}
                      aria-controls={`feeling-range-panel-${definition.id}-${level.id}`}
                      tabIndex={isSelected ? 0 : -1}
                      aria-label={`${level.min}–${level.max}: ${level.word}${isActive ? ', current range' : ''}${isCustomized ? ', customized' : ''}`}
                      onClick={() => setSelectedRangeLevelId(level.id)}
                      onKeyDown={(event) => {
                        const lastIndex = definition.levels.length - 1;
                        const nextIndex =
                          event.key === 'ArrowRight' || event.key === 'ArrowDown'
                            ? (levelIndex + 1) % definition.levels.length
                            : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                              ? (levelIndex - 1 + definition.levels.length) %
                                definition.levels.length
                              : event.key === 'Home'
                                ? 0
                                : event.key === 'End'
                                  ? lastIndex
                                  : null;
                        if (nextIndex === null) return;
                        event.preventDefault();
                        const tabs =
                          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                            '[role="tab"]',
                          );
                        setSelectedRangeLevelId(definition.levels[nextIndex].id);
                        tabs?.[nextIndex]?.focus();
                      }}
                    >
                      <i>
                        {level.min}–{level.max}
                      </i>
                      <strong>{level.word}</strong>
                      <span>
                        {isActive && <b>NOW</b>}
                        {isCustomized && <b>CUSTOM</b>}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div
                id={`feeling-range-panel-${definition.id}-${selectedRangeLevel.id}`}
                className="feelings-range-panel"
                role="tabpanel"
                aria-labelledby={`feeling-range-tab-${definition.id}-${selectedRangeLevel.id}`}
              >
                <div className="feelings-range-default">
                  <span>Default felt cause</span>
                  <p>{selectedRangeLevel.instruction}</p>
                </div>
                <label className="feelings-range-addition" htmlFor="feeling-range-addition">
                  <span>Your optional addition</span>
                  <textarea
                    id="feeling-range-addition"
                    aria-label={`Your added feeling for ${selectedRangeLevel.word}`}
                    maxLength={MAX_FEELING_RANGE_PROMPT_CHARS}
                    value={rangePromptDraft}
                    placeholder="Add a more personal felt pull for this range…"
                    disabled={mutationPending}
                    onChange={(event) => setRangePromptDraft(event.target.value)}
                  />
                  <small>
                    Added after the default · {rangePromptDraft.length}/
                    {MAX_FEELING_RANGE_PROMPT_CHARS}
                  </small>
                </label>
                <div className="feelings-range-actions">
                  <button
                    type="button"
                    disabled={mutationPending || !savedRangePrompt}
                    onClick={() =>
                      void runMutation(
                        () =>
                          updateBand({
                            rangePromptOverride: {
                              levelId: selectedRangeLevel.id,
                              instruction: null,
                            },
                          }),
                        `${definition.name} ${selectedRangeLevel.word} restored.`,
                      )
                    }
                  >
                    Restore default range feeling
                  </button>
                  <button
                    className="is-primary"
                    type="button"
                    disabled={
                      mutationPending ||
                      !rangePromptDraft.trim() ||
                      rangePromptDraft.trim() === savedRangePrompt
                    }
                    onClick={() =>
                      void runMutation(
                        () =>
                          updateBand({
                            rangePromptOverride: {
                              levelId: selectedRangeLevel.id,
                              instruction: rangePromptDraft.trim(),
                            },
                          }),
                        `${definition.name} ${selectedRangeLevel.word} customized.`,
                      )
                    }
                  >
                    Save range feeling
                  </button>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>

      <Dialog open={drawerOpen} onClose={setDrawerOpen} className="feelings-drawer-root">
        <button
          className="feelings-drawer-backdrop is-visible"
          type="button"
          aria-label="Close Reaction Cortex"
          onClick={() => setDrawerOpen(false)}
        />
        <DialogPanel className="feelings-drawer is-open">
          <div className="feelings-drawer-header">
            <div>
              <p className="feelings-kicker">Subconscious writer</p>
              <DialogTitle as="h2" id="reaction-title">
                Emotional Reaction Cortex
              </DialogTitle>
              <p>
                It reacts after the visible reply and moves the next state. It never delays the
                reply.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close Reaction Cortex"
            >
              <X size={18} />
            </button>
          </div>
          <div className={`feelings-drawer-status is-${health.status}`}>
            <span aria-hidden="true" />
            <div>
              <strong>{healthLabel}</strong>
              <small>
                Primary: {health.requestedModel || payload.config.reaction.model} ·{' '}
                {payload.config.reaction.fast ? 'Fast' : payload.config.reaction.serviceTier}
                {payload.config.reaction.fallbackProvider !== 'none' &&
                  payload.config.reaction.fallbackModel && (
                    <>
                      <br />
                      Fallback: {payload.config.reaction.fallbackModel}
                    </>
                  )}
                {health.lastUsedModel && (
                  <>
                    <br />
                    Last route: {health.lastUsedModel}
                    {health.lastUsedServiceTier ? ` · ${health.lastUsedServiceTier}` : ''}
                    {health.lastFallbackUsed
                      ? ` · fallback${
                          health.lastPrimaryErrorClass
                            ? ` after ${health.lastPrimaryErrorClass.replaceAll('_', ' ')}`
                            : ''
                        }`
                      : ''}
                  </>
                )}
              </small>
            </div>
          </div>
          <div className="feelings-drawer-field">
            <label htmlFor="reaction-activation">When should it activate?</label>
            <select
              id="reaction-activation"
              value={activationMode}
              onChange={(event) => setActivationMode(event.target.value as typeof activationMode)}
            >
              <option value="always">Always · default</option>
              <option value="classified">Only when the moment could move a feeling</option>
              <option value="disabled">Never</option>
            </select>
          </div>
          <div className="feelings-drawer-field">
            <label htmlFor="reaction-instruction">How should the subconscious react?</label>
            <textarea
              id="reaction-instruction"
              value={reactionInstruction}
              onChange={(event) => setReactionInstruction(event.target.value)}
            />
            <p>
              This belongs to the Reaction Cortex only. It is not added to Viventium’s speaking
              prompt.
            </p>
          </div>
          <div className="feelings-drawer-field">
            <span className="feelings-kicker">Context it receives</span>
            <ul>
              <li>current state</li>
              <li>band natures</li>
              <li>last 10 changes</li>
              <li>latest stimulus</li>
            </ul>
          </div>
          <div className="feelings-drawer-actions">
            <button
              type="button"
              className="is-danger"
              disabled={mutationPending}
              onClick={() => {
                if (!window.confirm('Turn off Feelings and permanently erase its saved state?')) {
                  return;
                }
                void runMutation(async () => {
                  await deleteMutation.mutateAsync(state.version);
                  setDrawerOpen(false);
                }, 'Feelings were turned off and erased.');
              }}
            >
              Turn off & erase
            </button>
            <button
              type="button"
              onClick={() =>
                setReactionInstruction(feelings.data.config.reaction.defaultInstruction)
              }
            >
              <RotateCcw size={14} /> Restore wording
            </button>
            <button
              className="is-primary"
              type="button"
              disabled={mutationPending || !reactionInstruction.trim()}
              onClick={() =>
                void runMutation(
                  () =>
                    updateProfile({
                      reactionInstruction: reactionInstruction.trim(),
                      reactionActivationMode: activationMode,
                    }),
                  'Reaction Cortex updated.',
                ).then(() => setDrawerOpen(false))
              }
            >
              Done
            </button>
          </div>
        </DialogPanel>
      </Dialog>
    </main>
  );
}
