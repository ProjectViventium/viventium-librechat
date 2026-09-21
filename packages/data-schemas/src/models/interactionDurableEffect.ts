/* === VIVENTIUM START === Provider-neutral durable interaction-effect model. === VIVENTIUM END === */

import interactionDurableEffectSchema from '~/schema/interactionDurableEffect';
import type { IInteractionDurableEffect } from '~/types/interactionDurableEffect';

export function createInteractionDurableEffectModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.InteractionDurableEffect ||
    mongoose.model<IInteractionDurableEffect>(
      'InteractionDurableEffect',
      interactionDurableEffectSchema,
    )
  );
}
