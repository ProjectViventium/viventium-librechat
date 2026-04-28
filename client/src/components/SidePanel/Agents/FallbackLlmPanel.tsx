/* === VIVENTIUM START ===
 * Feature: Agent Fallback LLM
 * Purpose: Nested Agent Builder panel for a user-configured secondary model route.
 * Added: 2026-04-28
 * === VIVENTIUM END === */
import type { AgentModelPanelProps } from '~/common';
import { Panel } from '~/common';
import { useLocalize } from '~/hooks';
import OptionalLlmPanel from './OptionalLlmPanel';

export default function FallbackLlmPanel({
  providers,
  setActivePanel,
  models: modelsData,
}: Pick<AgentModelPanelProps, 'models' | 'providers' | 'setActivePanel'>) {
  const localize = useLocalize();

  return (
    <OptionalLlmPanel
      models={modelsData}
      providers={providers}
      setActivePanel={setActivePanel}
      title={localize('com_ui_fallback_llm')}
      description={localize('com_ui_fallback_llm_description')}
      clearLabel={localize('com_ui_fallback_llm_clear')}
      backPanel={Panel.model}
      fields={{
        provider: 'fallback_llm_provider',
        model: 'fallback_llm_model',
        parameters: 'fallback_llm_model_parameters',
      }}
    />
  );
}
