import React, { useMemo } from 'react';
import keyBy from 'lodash/keyBy';
import { RotateCcw } from 'lucide-react';
import { useFormContext, useWatch } from 'react-hook-form';
import { componentMapping } from '~/components/SidePanel/Parameters/components';
import {
  getSettingsKeys,
  getEndpointField,
  type SettingDefinition,
  type AgentModelParameters,
  type AgentParameterValue,
  type TConversation,
  agentParamSettings,
} from 'librechat-data-provider';
import { useGetEndpointsQuery } from '~/data-provider';
import { useLiveAnnouncer } from '~/Providers';
import { useLocalize } from '~/hooks';
import type { AgentForm } from '~/common';

type ModelParameterFieldName =
  | 'model_parameters'
  | 'voice_llm_model_parameters'
  | 'fallback_llm_model_parameters'
  | 'voice_fallback_llm_model_parameters';

type ModelParametersSectionProps = {
  fieldName: ModelParameterFieldName;
  provider: string;
  model: string;
  title: string;
};

export default function ModelParametersSection({
  fieldName,
  provider,
  model,
  title,
}: ModelParametersSectionProps) {
  const localize = useLocalize();
  const { announcePolite } = useLiveAnnouncer();
  const { control, setValue } = useFormContext<AgentForm>();
  const parameterValues = useWatch({ control, name: fieldName }) as AgentModelParameters | undefined;
  const { data: endpointsConfig = {} } = useGetEndpointsQuery();

  const bedrockRegions = useMemo(
    () => endpointsConfig?.[provider]?.availableRegions ?? [],
    [endpointsConfig, provider],
  );

  const endpointType = useMemo(
    () => getEndpointField(endpointsConfig, provider, 'type'),
    [provider, endpointsConfig],
  );

  const parameters = useMemo((): SettingDefinition[] => {
    if (!provider) {
      return [];
    }

    const customParams = endpointsConfig[provider]?.customParams ?? {};
    const [combinedKey, endpointKey] = getSettingsKeys(endpointType ?? provider, model ?? '');
    const overriddenEndpointKey = customParams.defaultParamsEndpoint ?? endpointKey;
    const defaultParams =
      agentParamSettings[combinedKey] ?? agentParamSettings[overriddenEndpointKey] ?? [];
    const overriddenParams = endpointsConfig[provider]?.customParams?.paramDefinitions ?? [];
    const overriddenParamsMap = keyBy(overriddenParams, 'key');

    return defaultParams
      .filter((param) => param != null)
      .map((param) => (overriddenParamsMap[param.key] as SettingDefinition) ?? param);
  }, [endpointType, endpointsConfig, model, provider]);

  const setOption =
    (optionKey: keyof AgentModelParameters) => (value: AgentParameterValue) => {
      setValue(`${fieldName}.${optionKey}` as never, value as never);
    };

  const handleResetParameters = () => {
    setValue(fieldName as never, {} as never);
    announcePolite({
      message: localize('com_ui_reset_var', { 0: title }),
      isStatus: true,
    });
  };

  if (!parameters.length) {
    return null;
  }

  return (
    <>
      <div className="h-auto max-w-full overflow-x-hidden p-2">
        <div className="grid grid-cols-2 gap-4">
          {parameters.map((setting) => {
            const Component = componentMapping[setting.component];
            if (!Component) {
              return null;
            }

            const { key, default: defaultValue, ...rest } = setting;
            if (key === 'region' && bedrockRegions.length) {
              rest.options = bedrockRegions;
            }

            return (
              <Component
                key={key}
                settingKey={key}
                defaultValue={defaultValue}
                {...rest}
                setOption={setOption as never}
                conversation={parameterValues as Partial<TConversation>}
              />
            );
          })}
        </div>
      </div>
      <button
        type="button"
        onClick={handleResetParameters}
        className="btn btn-neutral my-1 flex w-full items-center justify-center gap-2 px-4 py-2 text-sm"
      >
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        {localize('com_ui_reset_var', { 0: title })}
      </button>
    </>
  );
}
