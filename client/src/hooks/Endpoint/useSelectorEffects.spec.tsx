import { renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import useSelectorEffects from './useSelectorEffects';
import { useGetStartupConfig } from '~/data-provider';
import useSetIndexOptions from '~/hooks/Conversations/useSetIndexOptions';

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetStartupConfig: jest.fn(),
}));

jest.mock('~/hooks/Conversations/useSetIndexOptions', () => jest.fn());

describe('useSelectorEffects', () => {
  const setModel = jest.fn();
  const setAgentId = jest.fn();

  beforeEach(() => {
    localStorage.clear();
    setModel.mockReset();
    setAgentId.mockReset();
    (useGetStartupConfig as jest.Mock).mockReturnValue({
      data: {
        interface: {
          defaultAgent: 'agent_viventium_main_95aeb3',
        },
      },
    });
    (useSetIndexOptions as jest.Mock).mockReturnValue({
      setOption: jest.fn((key: string) => {
        if (key === 'model') {
          return setModel;
        }
        if (key === 'agent_id') {
          return setAgentId;
        }
        return jest.fn();
      }),
    });
  });

  it('prefers the configured default agent over fetched list order for a fresh agent chat', () => {
    renderHook(() =>
      useSelectorEffects({
        index: 0,
        agentsMap: {
          agent_viventium_strategic_planning_95aeb3: {
            id: 'agent_viventium_strategic_planning_95aeb3',
            name: 'Strategic Planning',
          },
          agent_viventium_main_95aeb3: {
            id: 'agent_viventium_main_95aeb3',
            name: 'Viventium',
          },
        } as any,
        assistantsMap: undefined,
        conversation: {
          endpoint: EModelEndpoint.agents,
          agent_id: null,
        } as any,
        setSelectedValues: jest.fn(),
      }),
    );

    expect(setModel).toHaveBeenCalledWith('');
    expect(setAgentId).toHaveBeenCalledWith('agent_viventium_main_95aeb3');
  });

  it('preserves an existing saved agent selection when present', () => {
    localStorage.setItem('agent_id__0', 'agent_viventium_strategic_planning_95aeb3');

    renderHook(() =>
      useSelectorEffects({
        index: 0,
        agentsMap: {
          agent_viventium_strategic_planning_95aeb3: {
            id: 'agent_viventium_strategic_planning_95aeb3',
            name: 'Strategic Planning',
          },
          agent_viventium_main_95aeb3: {
            id: 'agent_viventium_main_95aeb3',
            name: 'Viventium',
          },
        } as any,
        assistantsMap: undefined,
        conversation: {
          endpoint: EModelEndpoint.agents,
          agent_id: null,
        } as any,
        setSelectedValues: jest.fn(),
      }),
    );

    expect(setAgentId).toHaveBeenCalledWith('agent_viventium_strategic_planning_95aeb3');
  });
});
