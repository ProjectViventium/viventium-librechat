export {
  GenerationJobManager,
  GenerationJobManagerClass,
  type GenerationJobManagerOptions,
} from './GenerationJobManager';

export type {
  SerializableJobData,
  IEventTransport,
  UsageMetadata,
  AbortResult,
  JobStatus,
  IJobStore,
  // VIVENTIUM START: export durable interaction and delivery contracts.
  InteractionContext,
  AdapterCapabilities,
  InteractionAdapterCapabilities,
  InteractionDeliveryPolicy,
  InteractionDeliveryAck,
  DeliveryAcknowledgementResult,
  DeliveryAcknowledgementState,
  // VIVENTIUM END
} from './interfaces/IJobStore';

export { createStreamServices } from './createStreamServices';
export type { StreamServicesConfig, StreamServices } from './createStreamServices';

// Implementations (for advanced use cases)
export { InMemoryJobStore } from './implementations/InMemoryJobStore';
export { InMemoryEventTransport } from './implementations/InMemoryEventTransport';
export { RedisJobStore } from './implementations/RedisJobStore';
export { RedisEventTransport } from './implementations/RedisEventTransport';
