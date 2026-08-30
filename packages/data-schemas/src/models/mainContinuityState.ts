/* === VIVENTIUM START === Provider-neutral accepted Main continuity state model. === VIVENTIUM END === */

import mainContinuityStateSchema from '~/schema/mainContinuityState';
import type { IViventiumMainContinuityState } from '~/types/mainContinuityState';

export function createViventiumMainContinuityStateModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ViventiumMainContinuityState ||
    mongoose.model<IViventiumMainContinuityState>(
      'ViventiumMainContinuityState',
      mainContinuityStateSchema,
    )
  );
}
