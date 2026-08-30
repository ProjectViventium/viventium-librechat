/* === VIVENTIUM START === Strict private request-pinned Feelings receipt types. === VIVENTIUM END === */

export type CortexFeelingAgentScope = 'all_agents' | 'conscious_agent';

export interface IViventiumCortexFeelingSnapshot {
  available: boolean;
  enabled: boolean;
  agentScope: CortexFeelingAgentScope;
  version: number;
  asOf: Date;
  capsule: string;
  snapshotHash: string;
  rangePromptOverrideCount: number;
  activeRangePromptOverrideCount: number;
  activeRangePromptOverrideChars: number;
}
