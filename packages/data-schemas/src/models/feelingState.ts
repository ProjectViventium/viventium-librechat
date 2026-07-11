import feelingStateSchema from '~/schema/feelingState';
import type { IFeelingState } from '~/types/feelingState';

export function createFeelingStateModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.FeelingState ||
    mongoose.model<IFeelingState>('FeelingState', feelingStateSchema)
  );
}
