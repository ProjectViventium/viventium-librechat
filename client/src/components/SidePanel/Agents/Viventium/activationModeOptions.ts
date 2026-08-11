/* === VIVENTIUM START ===
 * Feature: Background-cortex activation modes
 * Purpose: Keep Agent Builder's classified/always/disabled choices aligned with the runtime
 * contract while preserving the existing enabled switch as the master off control.
 * === VIVENTIUM END === */

import type { ActivationConfig, BackgroundCortexActivationMode } from 'librechat-data-provider';

type ActivationModeLabelKey =
  | 'com_ui_activation_mode_classified'
  | 'com_ui_activation_mode_always'
  | 'com_ui_activation_mode_disabled';

const ACTIVATION_MODES: BackgroundCortexActivationMode[] = ['classified', 'always', 'disabled'];

export function isActivationMode(value: string): value is BackgroundCortexActivationMode {
  return ACTIVATION_MODES.includes(value as BackgroundCortexActivationMode);
}

export function resolveActivationMode(
  activation: Pick<ActivationConfig, 'enabled' | 'mode'>,
): BackgroundCortexActivationMode {
  if (activation.enabled === false || activation.mode === 'disabled') {
    return 'disabled';
  }
  return activation.mode === 'always' ? 'always' : 'classified';
}

export function activationUpdatesForMode(
  mode: BackgroundCortexActivationMode,
): Pick<ActivationConfig, 'enabled' | 'mode'> {
  return { mode, enabled: mode !== 'disabled' };
}

export function activationUpdatesForEnabledSwitch(
  enabled: boolean,
  currentMode: BackgroundCortexActivationMode,
): Pick<ActivationConfig, 'enabled'> & Partial<Pick<ActivationConfig, 'mode'>> {
  if (enabled && currentMode === 'disabled') {
    return { enabled: true, mode: 'classified' };
  }
  return { enabled };
}

export function buildActivationModeOptions(
  localize: (key: ActivationModeLabelKey) => string,
): Array<{ label: string; value: BackgroundCortexActivationMode }> {
  return ACTIVATION_MODES.map((value) => ({
    label: localize(`com_ui_activation_mode_${value}` as ActivationModeLabelKey),
    value,
  }));
}
