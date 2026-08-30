/* === VIVENTIUM START === Generation-fenced GlassHive callback effect outbox model. === VIVENTIUM END === */

import glassHiveCallbackEffectOutboxSchema from '~/schema/glassHiveCallbackEffectOutbox';
import type { IViventiumGlassHiveCallbackEffectOutbox } from '~/types/glassHiveCallbackEffectOutbox';

export function createViventiumGlassHiveCallbackEffectOutboxModel(
  mongoose: typeof import('mongoose'),
) {
  return (
    mongoose.models.ViventiumGlassHiveCallbackEffectOutbox ||
    mongoose.model<IViventiumGlassHiveCallbackEffectOutbox>(
      'ViventiumGlassHiveCallbackEffectOutbox',
      glassHiveCallbackEffectOutboxSchema,
    )
  );
}
