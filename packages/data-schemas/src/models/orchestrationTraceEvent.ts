/* === VIVENTIUM START === Append-only redacted orchestration trace event model. === VIVENTIUM END === */

import type { Model } from 'mongoose';
import orchestrationTraceEventSchema from '~/schema/orchestrationTraceEvent';
import type {
  IViventiumOrchestrationTraceEvent,
  OrchestrationTraceScope,
} from '~/types/orchestrationTraceEvent';

export type ViventiumOrchestrationTraceEventModel = Model<IViventiumOrchestrationTraceEvent> & {
  withOrchestrationTraceScopeLock<T>(
    scope: OrchestrationTraceScope,
    operation: () => T | Promise<T>,
  ): Promise<T>;
};

export function createViventiumOrchestrationTraceEventModel(
  mongoose: typeof import('mongoose'),
): ViventiumOrchestrationTraceEventModel {
  return (mongoose.models.ViventiumOrchestrationTraceEvent ||
    mongoose.model<IViventiumOrchestrationTraceEvent>(
      'ViventiumOrchestrationTraceEvent',
      orchestrationTraceEventSchema,
    )) as ViventiumOrchestrationTraceEventModel;
}
