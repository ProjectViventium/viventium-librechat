/* === VIVENTIUM START === Durable Cortex insight delivery ledger model. === VIVENTIUM END === */

import cortexInsightDeliverySchema from '~/schema/cortexInsightDelivery';
import type { IViventiumCortexInsightDelivery } from '~/types/cortexInsightDelivery';

export function createViventiumCortexInsightDeliveryModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ViventiumCortexInsightDelivery ||
    mongoose.model<IViventiumCortexInsightDelivery>(
      'ViventiumCortexInsightDelivery',
      cortexInsightDeliverySchema,
    )
  );
}
