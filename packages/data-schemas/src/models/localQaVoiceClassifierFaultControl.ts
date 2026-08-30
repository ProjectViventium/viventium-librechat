import localQaVoiceClassifierFaultControlSchema from '~/schema/localQaVoiceClassifierFaultControl';
import type { ILocalQaVoiceClassifierFaultControl } from '~/types/localQaVoiceClassifierFaultControl';

export function createLocalQaVoiceClassifierFaultControlModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.LocalQaVoiceClassifierFaultControl ||
    mongoose.model<ILocalQaVoiceClassifierFaultControl>(
      'LocalQaVoiceClassifierFaultControl',
      localQaVoiceClassifierFaultControlSchema,
    )
  );
}
