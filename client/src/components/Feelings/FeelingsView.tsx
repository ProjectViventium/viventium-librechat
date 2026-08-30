import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, RotateCcw, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import type {
  FeelingBandId,
  FeelingBandDefinition,
  FeelingLevelId,
  FeelingReactionCause,
  FeelingTrailEntry,
  UpdateFeelingBand,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import {
  MAX_FEELING_RANGE_PROMPT_CHARS,
  VISIBLE_FEELING_TRAIL_LIMIT,
} from 'librechat-data-provider';
import ViventiumLogoIcon from '~/components/Endpoints/ViventiumLogoIcon';
import {
  useDeleteFeelingsMutation,
  useFeelingsQuery,
  useResetFeelingsMutation,
  useUpdateFeelingBandMutation,
  useUpdateFeelingsProfileMutation,
} from '~/data-provider';
import { useLocalize } from '~/hooks';
import './feelings.css';

const FUTURE_BANDS = [
  'com_ui_feelings_future_distress',
  'com_ui_feelings_future_anger',
  'com_ui_feelings_future_disgust',
  'com_ui_feelings_future_trust',
  'com_ui_feelings_future_guilt',
  'com_ui_feelings_future_confidence',
] as const satisfies TranslationKeys[];

const RETURN_SPEEDS = [
  { value: 10, label: 'com_ui_feelings_speed_very_fast' },
  { value: 20, label: 'com_ui_feelings_speed_fast' },
  { value: 45, label: 'com_ui_feelings_speed_medium' },
  { value: 90, label: 'com_ui_feelings_speed_slow' },
  { value: 240, label: 'com_ui_feelings_speed_very_slow' },
  { value: 480, label: 'com_ui_feelings_speed_long' },
  { value: 1440, label: 'com_ui_feelings_speed_enduring' },
] as const satisfies Array<{ value: number; label: TranslationKeys }>;

const REACTION_CAUSE_LABELS: Record<FeelingReactionCause, TranslationKeys> = {
  playful_exchange: 'com_ui_feelings_cause_playful_exchange',
  connection_bid: 'com_ui_feelings_cause_connection_bid',
  care_signal: 'com_ui_feelings_cause_care_signal',
  progress: 'com_ui_feelings_cause_progress',
  setback: 'com_ui_feelings_cause_setback',
  new_information: 'com_ui_feelings_cause_new_information',
  uncertainty: 'com_ui_feelings_cause_uncertainty',
  risk_or_boundary: 'com_ui_feelings_cause_risk_or_boundary',
  fatigue: 'com_ui_feelings_cause_fatigue',
  conflict: 'com_ui_feelings_cause_conflict',
  praise: 'com_ui_feelings_cause_praise',
  loss: 'com_ui_feelings_cause_loss',
  surprise: 'com_ui_feelings_cause_surprise',
  other: 'com_ui_feelings_cause_other',
  manual_adjustment: 'com_ui_feelings_cause_manual_adjustment',
  reset_to_nature: 'com_ui_feelings_cause_reset_to_nature',
};

const TRAIL_VERB_LABELS = {
  up: {
    slight: 'com_ui_feelings_trail_rose_slightly',
    clear: 'com_ui_feelings_trail_rose_clearly',
    strong: 'com_ui_feelings_trail_rose_strongly',
  },
  down: {
    slight: 'com_ui_feelings_trail_fell_slightly',
    clear: 'com_ui_feelings_trail_fell_clearly',
    strong: 'com_ui_feelings_trail_fell_strongly',
  },
} as const satisfies Record<
  FeelingTrailEntry['direction'],
  Record<FeelingTrailEntry['strength'], TranslationKeys>
>;

const TRAIL_SOURCE_LABELS = {
  user_turn: 'com_ui_feelings_trail_source_user',
  manual: 'com_ui_feelings_trail_source_manual',
  reset: 'com_ui_feelings_trail_source_reset',
} as const satisfies Record<FeelingTrailEntry['sourceType'], TranslationKeys>;

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

function halfLifeLabel(minutes: number, localize: ReturnType<typeof useLocalize>, short = false) {
  if (minutes % 1440 === 0) {
    return localize(short ? 'com_ui_feelings_duration_days' : 'com_ui_feelings_half_life_days', {
      0: minutes / 1440,
    });
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return localize(short ? 'com_ui_feelings_duration_hours' : 'com_ui_feelings_half_life_hours', {
      0: minutes / 60,
    });
  }
  return localize(
    short ? 'com_ui_feelings_duration_minutes' : 'com_ui_feelings_half_life_minutes',
    {
      0: minutes,
    },
  );
}

function deltaLabel(current: number, baseline: number, localize: ReturnType<typeof useLocalize>) {
  const delta = Math.round(current - baseline);
  if (Math.abs(delta) < 1) return localize('com_ui_feelings_at_nature');
  return localize(delta > 0 ? 'com_ui_feelings_above_nature' : 'com_ui_feelings_below_nature', {
    0: Math.abs(delta),
  });
}

function trailVerb(
  direction: FeelingTrailEntry['direction'],
  strength: FeelingTrailEntry['strength'],
  localize: ReturnType<typeof useLocalize>,
) {
  return localize(TRAIL_VERB_LABELS[direction][strength]);
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function innerStateAge(generatedAt: string, localize: ReturnType<typeof useLocalize>) {
  const elapsedMs = Math.max(0, Date.now() - new Date(generatedAt).getTime());
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1) return localize('com_ui_feelings_formed_now');
  if (minutes < 60) return localize('com_ui_feelings_formed_minutes', { 0: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return localize('com_ui_feelings_formed_hours', { 0: hours });
  return localize('com_ui_feelings_formed_days', { 0: Math.floor(hours / 24) });
}

type FeelingRequestError = {
  code?: string;
  status?: number;
  response?: {
    status?: number;
    data?: { code?: string; error?: { code?: string } };
  };
};

function feelingRequestFailure(error: unknown) {
  if (!error || typeof error !== 'object') {
    return { status: undefined, code: undefined };
  }
  const failure = error as FeelingRequestError;
  return {
    status: failure.response?.status ?? failure.status,
    code: failure.response?.data?.error?.code ?? failure.response?.data?.code ?? failure.code,
  };
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
  const location = useLocation();
  const navigate = useNavigate();
  const localize = useLocalize();
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
  const reactionInstructionRef = useRef(reactionInstruction);
  const activationModeRef = useRef(activationMode);
  const reactionSyncRef = useRef({
    instruction: '',
    activationMode: 'always' as typeof activationMode,
  });
  const mutationPending =
    profileMutation.isLoading ||
    bandMutation.isLoading ||
    resetMutation.isLoading ||
    deleteMutation.isLoading;
  draggingBandIdRef.current = draggingBandId;
  rangePromptDraftRef.current = rangePromptDraft;
  reactionInstructionRef.current = reactionInstruction;
  activationModeRef.current = activationMode;
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
    const savedInstruction =
      state.reactionInstruction || feelings.data?.config.reaction.defaultInstruction || '';
    const previous = reactionSyncRef.current;
    if (!drawerOpen || reactionInstructionRef.current === previous.instruction) {
      setReactionInstruction(savedInstruction);
    }
    if (!drawerOpen || activationModeRef.current === previous.activationMode) {
      setActivationMode(state.reactionActivationMode);
    }
    reactionSyncRef.current = {
      instruction: savedInstruction,
      activationMode: state.reactionActivationMode,
    };
  }, [drawerOpen, feelings.data?.config.reaction.defaultInstruction, state]);

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

  function returnToChat() {
    if (location.key !== 'default' || Number(window.history.state?.idx ?? 0) > 0) {
      navigate(-1);
      return;
    }
    navigate('/c/new', { replace: true });
  }

  async function runMutation(task: () => Promise<unknown>, success: string): Promise<boolean> {
    setNotice('');
    try {
      await task();
      setNotice(success);
      return true;
    } catch (error) {
      const failure = feelingRequestFailure(error);
      if (failure.status === 409 && failure.code === 'FEELINGS_VERSION_CONFLICT') {
        setNotice(localize('com_ui_feelings_error_conflict'));
        await feelings.refetch();
        return false;
      }
      if (failure.status === 401 || failure.status === 403) {
        setNotice(localize('com_ui_feelings_error_forbidden'));
        return false;
      }
      if (failure.status === 422 || failure.code === 'FEELINGS_VALIDATION_ERROR') {
        setNotice(localize('com_ui_feelings_error_validation'));
        return false;
      }
      if (
        failure.status == null ||
        failure.status >= 500 ||
        failure.status === 408 ||
        failure.status === 429 ||
        failure.code === 'FEELINGS_UNAVAILABLE'
      ) {
        setNotice(localize('com_ui_feelings_error_unavailable'));
        return false;
      }
      setNotice(localize('com_ui_feelings_error_save'));
      return false;
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
        localize(
          field === 'current'
            ? 'com_ui_feelings_band_moved'
            : 'com_ui_feelings_band_nature_changed',
          { 0: bandName },
        ),
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
      localize(
        field === 'current' ? 'com_ui_feelings_band_moved' : 'com_ui_feelings_band_nature_changed',
        { 0: bandName },
      ),
    );
  }

  if (feelings.isLoading) {
    return (
      <main className="feelings-view feelings-loading" aria-busy="true">
        <div className="feelings-orb" />
        <span>{localize('com_ui_feelings_loading')}</span>
      </main>
    );
  }

  if (feelings.isError || !payload || !state || !definition || !selectedBand) {
    const failure = feelingRequestFailure(feelings.error);
    const message =
      failure.status === 401 || failure.status === 403
        ? 'com_ui_feelings_error_view_forbidden'
        : failure.status != null && failure.status >= 500
          ? 'com_ui_feelings_error_load_unavailable'
          : 'com_ui_feelings_load_error';
    return (
      <main className="feelings-view feelings-loading">
        <strong>{localize(message)}</strong>
        <button type="button" onClick={() => feelings.refetch()}>
          {localize('com_ui_retry')}
        </button>
      </main>
    );
  }

  if (!payload.config.available || !state.available) {
    return (
      <main className="feelings-view feelings-loading">
        <strong>{localize('com_ui_feelings_configuration_unavailable')}</strong>
        <button type="button" onClick={returnToChat}>
          {localize('com_ui_back_to_chat')}
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
      ? localize('com_ui_feelings_health_running')
      : health.status === 'healthy'
        ? localize('com_ui_feelings_health_ready', { 0: health.lastDurationMs ?? 0 })
        : health.status === 'degraded'
          ? localize('com_ui_feelings_health_attention', {
              0: health.lastErrorClass || localize('com_ui_feelings_health_reaction_failed'),
              1: health.lastErrorDetail ? ` · ${health.lastErrorDetail}` : '',
            })
          : health.status === 'skipped'
            ? localize('com_ui_feelings_health_skipped', {
                0: health.lastSkipReason || localize('com_ui_feelings_health_skip_not_needed'),
              })
            : localize('com_ui_feelings_health_waiting');

  return (
    <main className="feelings-view" style={selectedColorStyle}>
      <div className="feelings-shell">
        <header className="feelings-topbar">
          <div className="feelings-brand">
            <button
              className="feelings-back min-h-6 min-w-6"
              type="button"
              onClick={returnToChat}
              aria-label={localize('com_ui_back_to_chat')}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <ViventiumLogoIcon
              className="feelings-brand-mark"
              alt={localize('com_ui_logo', { 0: 'Viventium' })}
            />
            <div>
              <p>{localize('com_ui_feelings_brand')}</p>
              <span>{localize('com_ui_feelings_brand_description')}</span>
            </div>
          </div>
          <div className="feelings-actions">
            <button className="feelings-utility" type="button" onClick={() => setDrawerOpen(true)}>
              {localize('com_ui_feelings_reaction_cortex')}
            </button>
            <button
              className="feelings-utility reset-label"
              type="button"
              aria-label={localize('com_ui_feelings_reset_state')}
              disabled={mutationPending}
              onClick={() =>
                void runMutation(
                  () => resetMutation.mutateAsync(state.version),
                  localize('com_ui_feelings_reset_complete'),
                )
              }
            >
              <RotateCcw size={14} aria-hidden="true" />
              <span>{localize('com_ui_feelings_reset_state')}</span>
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
                  localize(
                    state.enabled
                      ? 'com_ui_feelings_disabled_notice'
                      : 'com_ui_feelings_enabled_notice',
                  ),
                )
              }
            >
              <span>
                {localize(state.enabled ? 'com_ui_feelings_enabled' : 'com_ui_feelings_enable')}
              </span>
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
                <p className="feelings-kicker">{localize('com_ui_feelings_inner_state')}</p>
                <h1 id="feelings-title">{localize('com_ui_feelings_spectrum')}</h1>
                <p>{localize('com_ui_feelings_spectrum_description')}</p>
              </div>
              <div className="feelings-live-readout">
                <span className={health.status === 'degraded' ? 'is-degraded' : ''} />
                {healthLabel}
              </div>
            </div>

            {state.enabled && (
              <section className="feelings-inner-state" aria-live="polite">
                <div>
                  <span>{localize('com_ui_feelings_own_words')}</span>
                  {state.innerState && (
                    <time dateTime={state.innerState.generatedAt}>
                      {localize('com_ui_feelings_last_felt_sense', {
                        0: innerStateAge(state.innerState.generatedAt, localize),
                      })}
                    </time>
                  )}
                </div>
                <p>{state.innerState?.text || localize('com_ui_feelings_waiting_for_reaction')}</p>
              </section>
            )}

            <div className={`feelings-instrument ${state.enabled ? '' : 'is-off'}`}>
              <div className="feelings-heartbeat" aria-hidden="true" />
              <div
                className="feelings-spectrum"
                aria-label={localize('com_ui_feelings_band_count', { 0: definitions.length })}
              >
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
                        aria-label={localize('com_ui_feelings_band_select', {
                          0: bandDefinition.name,
                          1: current,
                          2: baseline,
                        })}
                      >
                        <i className="feelings-band-signal" aria-hidden="true" />
                        <span className="feelings-lane-name">{bandDefinition.name}</span>
                        <span className="feelings-lane-values">
                          <b>
                            {localize('com_ui_feelings_now')} {current}
                          </b>
                          <i>
                            {localize('com_ui_feelings_nature')} {baseline}
                          </i>
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
                          aria-label={localize('com_ui_feelings_band_nature', {
                            0: bandDefinition.name,
                          })}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={baseline}
                          aria-valuetext={localize('com_ui_feelings_nature_value', {
                            0: baseline,
                            1: bandDefinition.highLabel,
                          })}
                          onPointerDown={(event) =>
                            beginLaneDrag(event, bandDefinition.id, 'baseline')
                          }
                          onKeyDown={(event) =>
                            moveLaneWithKeyboard(event, bandDefinition.id, 'baseline', baseline)
                          }
                        >
                          <span aria-hidden="true">
                            {localize('com_ui_feelings_nature').slice(0, 1)}
                          </span>
                        </button>
                        <button
                          className="feelings-current-marker"
                          style={{ bottom: `${current}%` }}
                          type="button"
                          role="slider"
                          aria-label={localize('com_ui_feelings_band_current', {
                            0: bandDefinition.name,
                          })}
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
                          {band.enabled
                            ? feelingWord(bandDefinition, current)
                            : localize('com_ui_feelings_not_felt')}
                        </span>
                        <span>{halfLifeLabel(band.halfLifeMinutes, localize, true)}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="feelings-legend">
                <div>
                  <span>
                    <i className="legend-current" />
                    {localize('com_ui_feelings_current')}
                  </span>
                  <span>
                    <i className="legend-nature" />
                    {localize('com_ui_feelings_nature_resting_line')}
                  </span>
                </div>
                <span>{localize('com_ui_feelings_marker_help')}</span>
              </div>
              {!state.enabled && (
                <div className="feelings-off-overlay">
                  <div className="feelings-off-message">
                    <div className="feelings-off-orb" aria-hidden="true" />
                    <strong>{localize('com_ui_feelings_off')}</strong>
                    <span>{localize('com_ui_feelings_off_description')}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="feelings-state-details">
              <section className="feelings-capsule" aria-labelledby="capsule-title">
                <div>
                  <h3 id="capsule-title">{localize('com_ui_feelings_capsule')}</h3>
                  <span>
                    {localize('com_ui_feelings_felt_count', {
                      0: activeBands,
                      1: definitions.length,
                    })}
                  </span>
                </div>
                {state.capsule ? (
                  <pre>{state.capsule}</pre>
                ) : (
                  <p>{localize('com_ui_feelings_capsule_empty')}</p>
                )}
              </section>

              <section className="feelings-trail" aria-labelledby="trail-title">
                <div>
                  <div>
                    <h3 id="trail-title">{localize('com_ui_feelings_reaction_trail')}</h3>
                    <p>{localize('com_ui_feelings_reaction_trail_description')}</p>
                  </div>
                  <span>
                    {localize('com_ui_feelings_trail_limit', { 0: VISIBLE_FEELING_TRAIL_LIMIT })}
                  </span>
                </div>
                <div className="feelings-trail-list">
                  {state.trail.length === 0 && <p>{localize('com_ui_feelings_trail_empty')}</p>}
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
                              {localize(
                                REACTION_CAUSE_LABELS[entry.cause] ||
                                  (entry.sourceType === 'user_turn'
                                    ? 'com_ui_feelings_trail_user_moment'
                                    : 'com_ui_feelings_trail_manual_change'),
                              )}
                            </em>
                            <strong>
                              {entryDefinition?.name || entry.band}{' '}
                              {trailVerb(entry.direction, entry.strength, localize)}
                            </strong>
                            <span>
                              {Math.round(entry.before)} → {Math.round(entry.after)} ·{' '}
                              {localize(TRAIL_SOURCE_LABELS[entry.sourceType])}
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
                <span>{localize('com_ui_feelings_research')}</span>
                <span>
                  {localize('com_ui_feelings_research_count', { 0: FUTURE_BANDS.length })}
                </span>
              </summary>
              <div>
                {FUTURE_BANDS.map((band) => (
                  <span key={band}>{localize(band)}</span>
                ))}
              </div>
            </details>
          </section>

          <aside
            className="feelings-inspector"
            aria-label={localize('com_ui_feelings_selected_controls')}
          >
            <div className="feelings-inspector-header">
              <div>
                <div className="feelings-selected-signal" aria-hidden="true" />
                <p className="feelings-kicker">{localize('com_ui_feelings_selected')}</p>
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
                    localize(
                      selectedBand.enabled
                        ? 'com_ui_feelings_band_disabled'
                        : 'com_ui_feelings_band_enabled',
                      { 0: definition.name },
                    ),
                  )
                }
              >
                <span>{localize('com_ui_feelings_felt')}</span>
                <i className="feelings-switch" aria-hidden="true" />
              </button>
            </div>

            <div className="feelings-felt-readout">
              <div>
                <strong>{feelingWord(definition, draftCurrent)}</strong>
                <span>{deltaLabel(draftCurrent, draftBaseline, localize)}</span>
              </div>
              <div
                className="feelings-state-compare"
                aria-label={localize('com_ui_feelings_comparison')}
              >
                <span className="is-current">
                  <i>{localize('com_ui_feelings_now')}</i>
                  <b>{draftCurrent}</b>
                </span>
                <span className="is-nature">
                  <i>{localize('com_ui_feelings_nature')}</i>
                  <b>{draftBaseline}</b>
                </span>
              </div>
            </div>

            <div className="feelings-control is-current">
              <label htmlFor="feeling-current">
                <span>
                  <i>{localize('com_ui_feelings_now')}</i> {localize('com_ui_feelings_current')}
                </span>
                <output>{draftCurrent}</output>
              </label>
              <input
                id="feeling-current"
                aria-label={localize('com_ui_feelings_current')}
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
                    localize('com_ui_feelings_band_moved', { 0: definition.name }),
                  )
                }
                onKeyUp={(event) => {
                  if (!RANGE_COMMIT_KEYS.has(event.key)) return;
                  void runMutation(
                    () => updateBand({ current: draftCurrent }),
                    localize('com_ui_feelings_band_moved', { 0: definition.name }),
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
                  <i>{localize('com_ui_feelings_nature')}</i>{' '}
                  {localize('com_ui_feelings_resting_point')}
                </span>
                <output>{draftBaseline}</output>
              </label>
              <input
                id="feeling-nature"
                aria-label={localize('com_ui_feelings_nature_resting_point')}
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
                    localize('com_ui_feelings_band_nature_changed', { 0: definition.name }),
                  )
                }
                onKeyUp={(event) => {
                  if (!RANGE_COMMIT_KEYS.has(event.key)) return;
                  void runMutation(
                    () => updateBand({ baseline: draftBaseline }),
                    localize('com_ui_feelings_band_nature_changed', { 0: definition.name }),
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
                <span>{localize('com_ui_feelings_return_speed')}</span>
                <output>{halfLifeLabel(draftHalfLife, localize)}</output>
              </label>
              <select
                id="feeling-return"
                aria-label={localize('com_ui_feelings_return_speed')}
                value={draftHalfLife}
                disabled={mutationPending}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setDraftHalfLife(next);
                  void runMutation(
                    () => updateBand({ halfLifeMinutes: next }),
                    localize('com_ui_feelings_return_speed_changed', { 0: definition.name }),
                  );
                }}
              >
                {!RETURN_SPEEDS.some((speed) => speed.value === draftHalfLife) && (
                  <option value={draftHalfLife}>{halfLifeLabel(draftHalfLife, localize)}</option>
                )}
                {RETURN_SPEEDS.map((speed) => (
                  <option key={speed.value} value={speed.value}>
                    {localize(speed.label)}
                  </option>
                ))}
              </select>
            </div>

            <section className="feelings-range-editor" aria-labelledby="range-editor-title">
              <div className="feelings-range-heading">
                <div>
                  <h3 id="range-editor-title">{localize('com_ui_feelings_ranges')}</h3>
                  <p>{localize('com_ui_feelings_ranges_description')}</p>
                </div>
                <span>
                  {localize('com_ui_feelings_ranges_customized', {
                    0: state.rangePromptOverrideCount,
                  })}
                </span>
              </div>
              <div
                className="feelings-range-tabs"
                role="tablist"
                aria-label={localize('com_ui_feelings_band_ranges', { 0: definition.name })}
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
                      aria-label={localize('com_ui_feelings_range_label', {
                        0: level.min,
                        1: level.max,
                        2: level.word,
                        3: isActive ? localize('com_ui_feelings_current_range') : '',
                        4: isCustomized ? localize('com_ui_feelings_customized_range') : '',
                      })}
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
                        {isActive && <b>{localize('com_ui_feelings_now')}</b>}
                        {isCustomized && <b>{localize('com_ui_feelings_custom')}</b>}
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
                  <span>{localize('com_ui_feelings_range_default')}</span>
                  <p>{selectedRangeLevel.instruction}</p>
                </div>
                <label className="feelings-range-addition" htmlFor="feeling-range-addition">
                  <span>{localize('com_ui_feelings_range_addition')}</span>
                  <textarea
                    id="feeling-range-addition"
                    aria-label={localize('com_ui_feelings_range_added_for', {
                      0: selectedRangeLevel.word,
                    })}
                    maxLength={MAX_FEELING_RANGE_PROMPT_CHARS}
                    value={rangePromptDraft}
                    placeholder={localize('com_ui_feelings_range_placeholder')}
                    disabled={mutationPending}
                    onChange={(event) => setRangePromptDraft(event.target.value)}
                  />
                  <small>
                    {localize('com_ui_feelings_range_limit', {
                      0: rangePromptDraft.length,
                      1: MAX_FEELING_RANGE_PROMPT_CHARS,
                    })}
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
                        localize('com_ui_feelings_range_restored', {
                          0: definition.name,
                          1: selectedRangeLevel.word,
                        }),
                      )
                    }
                  >
                    {localize('com_ui_feelings_range_restore')}
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
                        localize('com_ui_feelings_range_saved', {
                          0: definition.name,
                          1: selectedRangeLevel.word,
                        }),
                      )
                    }
                  >
                    {localize('com_ui_feelings_range_save')}
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
          aria-label={localize('com_ui_feelings_reaction_close')}
          onClick={() => setDrawerOpen(false)}
        />
        <DialogPanel className="feelings-drawer is-open">
          <div className="feelings-drawer-header">
            <div>
              <p className="feelings-kicker">{localize('com_ui_feelings_reaction_subconscious')}</p>
              <DialogTitle as="h2" id="reaction-title">
                {localize('com_ui_feelings_reaction_cortex_title')}
              </DialogTitle>
              <p>{localize('com_ui_feelings_reaction_description')}</p>
            </div>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label={localize('com_ui_feelings_reaction_close')}
            >
              <X size={18} />
            </button>
          </div>
          <div className={`feelings-drawer-status is-${health.status}`}>
            <span aria-hidden="true" />
            <div>
              <strong>{healthLabel}</strong>
              <small>
                {localize('com_ui_feelings_reaction_primary', {
                  0: health.requestedModel || payload.config.reaction.model,
                  1: payload.config.reaction.fast
                    ? localize('com_ui_feelings_fast')
                    : payload.config.reaction.serviceTier,
                })}
                {payload.config.reaction.fallbackProvider !== 'none' &&
                  payload.config.reaction.fallbackModel && (
                    <>
                      <br />
                      {localize('com_ui_feelings_reaction_fallback', {
                        0: payload.config.reaction.fallbackModel,
                      })}
                    </>
                  )}
                {health.lastUsedModel && (
                  <>
                    <br />
                    {health.lastUsedServiceTier
                      ? localize('com_ui_feelings_reaction_last_route', {
                          0: health.lastUsedModel,
                          1: health.lastUsedServiceTier,
                        })
                      : localize('com_ui_feelings_reaction_last_route_without_tier', {
                          0: health.lastUsedModel,
                        })}
                    {health.lastFallbackUsed
                      ? ` · ${
                          health.lastPrimaryErrorClass
                            ? localize('com_ui_feelings_reaction_fallback_after', {
                                0: health.lastPrimaryErrorClass.replaceAll('_', ' '),
                              })
                            : localize('com_ui_feelings_reaction_fallback_used')
                        }`
                      : ''}
                  </>
                )}
              </small>
            </div>
          </div>
          <div className="feelings-drawer-field">
            <label htmlFor="reaction-activation">
              {localize('com_ui_feelings_reaction_activation')}
            </label>
            <select
              id="reaction-activation"
              value={activationMode}
              onChange={(event) => setActivationMode(event.target.value as typeof activationMode)}
            >
              <option value="always">{localize('com_ui_feelings_reaction_always')}</option>
              <option value="classified">{localize('com_ui_feelings_reaction_classified')}</option>
              <option value="disabled">{localize('com_ui_feelings_reaction_disabled')}</option>
            </select>
          </div>
          <div className="feelings-drawer-field">
            <label htmlFor="reaction-instruction">
              {localize('com_ui_feelings_reaction_instruction')}
            </label>
            <textarea
              id="reaction-instruction"
              value={reactionInstruction}
              onChange={(event) => setReactionInstruction(event.target.value)}
            />
            <p>{localize('com_ui_feelings_reaction_instruction_description')}</p>
          </div>
          <div className="feelings-drawer-field">
            <span className="feelings-kicker">{localize('com_ui_feelings_reaction_context')}</span>
            <ul>
              <li>{localize('com_ui_feelings_reaction_context_state')}</li>
              <li>{localize('com_ui_feelings_reaction_context_natures')}</li>
              <li>
                {localize('com_ui_feelings_reaction_context_changes', {
                  0: VISIBLE_FEELING_TRAIL_LIMIT,
                })}
              </li>
              <li>{localize('com_ui_feelings_reaction_context_stimulus')}</li>
            </ul>
          </div>
          <div className="feelings-drawer-actions">
            <button
              type="button"
              className="is-danger"
              disabled={mutationPending}
              onClick={() => {
                if (!window.confirm(localize('com_ui_feelings_erase_confirmation'))) {
                  return;
                }
                void runMutation(async () => {
                  await deleteMutation.mutateAsync(state.version);
                  setDrawerOpen(false);
                }, localize('com_ui_feelings_erased'));
              }}
            >
              {localize('com_ui_feelings_erase')}
            </button>
            <button
              type="button"
              onClick={() =>
                setReactionInstruction(feelings.data.config.reaction.defaultInstruction)
              }
            >
              <RotateCcw size={14} /> {localize('com_ui_feelings_restore_wording')}
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
                  localize('com_ui_feelings_reaction_saved'),
                ).then((saved) => {
                  if (saved) setDrawerOpen(false);
                })
              }
            >
              {localize('com_ui_done')}
            </button>
          </div>
        </DialogPanel>
      </Dialog>
    </main>
  );
}
