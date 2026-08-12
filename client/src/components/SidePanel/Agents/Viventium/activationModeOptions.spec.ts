/* === VIVENTIUM START ===
 * Feature: Background-cortex activation modes
 * Purpose: Regression coverage for the Agent Builder's classified/always/disabled contract.
 * === VIVENTIUM END === */

import {
  activationModeHintKey,
  activationUpdatesForEnabledSwitch,
  activationUpdatesForMode,
  buildActivationModeOptions,
  resolveActivationMode,
} from './activationModeOptions';

describe('activation mode options', () => {
  it('uses explicit localized hint keys for every mode', () => {
    expect(activationModeHintKey('classified')).toBe('com_ui_activation_mode_classified_hint');
    expect(activationModeHintKey('always')).toBe('com_ui_activation_mode_always_hint');
    expect(activationModeHintKey('disabled')).toBe('com_ui_activation_mode_disabled_hint');
  });

  test('defaults legacy configurations to classified mode', () => {
    expect(resolveActivationMode({ enabled: true })).toBe('classified');
  });

  test('keeps the master enabled switch authoritative', () => {
    expect(resolveActivationMode({ enabled: false, mode: 'always' })).toBe('disabled');
  });

  test('exposes the closed mode set to Agent Builder', () => {
    const localize = (key: string) => key;

    expect(buildActivationModeOptions(localize)).toEqual([
      { label: 'com_ui_activation_mode_classified', value: 'classified' },
      { label: 'com_ui_activation_mode_always', value: 'always' },
      { label: 'com_ui_activation_mode_disabled', value: 'disabled' },
    ]);
  });

  test('keeps the mode selector and master switch from deadlocking each other', () => {
    expect(activationUpdatesForMode('disabled')).toEqual({ mode: 'disabled', enabled: false });
    expect(activationUpdatesForMode('always')).toEqual({ mode: 'always', enabled: true });
    expect(activationUpdatesForMode('classified')).toEqual({ mode: 'classified', enabled: true });
    expect(activationUpdatesForEnabledSwitch(true, 'disabled')).toEqual({
      enabled: true,
      mode: 'classified',
    });
    expect(activationUpdatesForEnabledSwitch(false, 'always')).toEqual({ enabled: false });
  });
});
