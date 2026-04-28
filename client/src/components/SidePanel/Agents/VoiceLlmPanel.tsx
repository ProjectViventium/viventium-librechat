import { useFormContext, useWatch } from 'react-hook-form';
import { ChevronRight } from 'lucide-react';
import type { AgentForm, AgentModelPanelProps } from '~/common';
import { Panel } from '~/common';
import { useLocalize } from '~/hooks';
import OptionalLlmPanel from './OptionalLlmPanel';

export default function VoiceLlmPanel({
  providers,
  setActivePanel,
  models: modelsData,
}: Pick<AgentModelPanelProps, 'models' | 'providers' | 'setActivePanel'>) {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();
  const voiceFallbackModel = useWatch({ control, name: 'voice_fallback_llm_model' });
  const voiceFallbackProvider = useWatch({ control, name: 'voice_fallback_llm_provider' });

  return (
    <OptionalLlmPanel
      models={modelsData}
      providers={providers}
      setActivePanel={setActivePanel}
      title={localize('com_ui_voice_chat_llm')}
      description={localize('com_ui_voice_chat_llm_description')}
      clearLabel={localize('com_ui_voice_chat_llm_clear')}
      fields={{
        provider: 'voice_llm_provider',
        model: 'voice_llm_model',
        parameters: 'voice_llm_model_parameters',
      }}
    >
      {/* === VIVENTIUM START ===
       * Feature: Voice Fallback LLM
       * Purpose: Let the voice model own its own secondary route from the same nested panel flow.
       * Added: 2026-04-28
       */}
      <div className="model-panel-section mx-2 mb-4">
        <label
          id="voice-fallback-llm-label"
          className="text-token-text-primary model-panel-label mb-2 block font-medium"
        >
          {localize('com_ui_fallback_llm')}
        </label>
        <button
          type="button"
          onClick={() => setActivePanel(Panel.voiceFallbackLlmModel)}
          className="btn btn-neutral border-token-border-light relative h-10 w-full rounded-lg font-medium"
          aria-haspopup="true"
          aria-expanded="false"
          aria-labelledby="voice-fallback-llm-label"
        >
          <div className="flex w-full items-center justify-between gap-2">
            <span className="truncate text-left">
              {voiceFallbackModel && voiceFallbackProvider
                ? `${voiceFallbackModel}`
                : localize('com_ui_voice_fallback_llm_empty')}
            </span>
            <ChevronRight className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          </div>
        </button>
        <p className="text-token-text-secondary mt-1 text-xs">
          {localize('com_ui_voice_fallback_llm_short_description')}
        </p>
      </div>
      {/* === VIVENTIUM END === */}
    </OptionalLlmPanel>
  );
}
