/* === VIVENTIUM START === Append-only redacted orchestration trace event types. === VIVENTIUM END === */

export interface IOrchestrationTraceFacts {
  sourceEventRefHash?: string;
  logicalTurnRefHash?: string;
  workRefHash?: string;
  runRefHash?: string;
  callbackRefHash?: string;
  deliveryRefHash?: string;
  callSessionRefHash?: string;
  taskRefHash?: string;
  streamRefHash?: string;
  actionRefHash?: string;
  receiptRefHash?: string;
  attemptRefHash?: string;
  providerRequestRefHash?: string;
  primaryAttemptRefHash?: string;
  fallbackAttemptRefHash?: string;
  responseRefHash?: string;
  presentationRefHash?: string;
  state?: string;
  surface?: string;
  callbackEvent?: string;
  deliveryState?: string;
  terminal?: boolean;
  attemptNumber?: number;
  promptLayerContractVersion?: number;
  producerTraceContractVersion?: number;
  promptProducerScope?: string;
  unknownPromptLayerCount?: number;
  producerLifecycleHash?: string;
  producerAttemptHistoryHash?: string;
  producerCapacityHistoryHash?: string;
  producerCallbackHistoryHash?: string;
  producerPromptHash?: string;
  producerArtifactRefsHash?: string;
  candidateDigest?: string;
  runtimeOwnerBindingHash?: string;
  installedArtifactDigest?: string;
  contextSnapshotHash?: string;
  capabilitySetHash?: string;
  effectPlane?: string;
  outcome?: string;
  action?: string;
  provider?: string;
  model?: string;
  providerStatus?: string;
  attemptRole?: string;
  primaryProvider?: string;
  primaryModel?: string;
  primaryProviderStatus?: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  fallbackProviderStatus?: string;
  configuredFallback?: boolean;
  requiredCapabilitiesPreserved?: boolean;
  effectCount?: number;
}

export interface IViventiumOrchestrationTraceEvent {
  schemaVersion: 1;
  ownerScopeHash: string;
  originRefHash: string;
  sequence: number;
  stage: string;
  at: Date;
  facts: IOrchestrationTraceFacts;
  eventKeyHash: string;
  contentHash: string;
  previousEventHash: string;
  eventHash: string;
  createdAt: Date;
}

export interface OrchestrationTraceScope {
  ownerScopeHash: string;
  originRefHash: string;
}
