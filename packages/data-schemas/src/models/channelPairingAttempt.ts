import channelPairingAttemptSchema from '~/schema/channelPairingAttempt';
import type { IChannelPairingAttempt } from '~/types/channel';

export function createChannelPairingAttemptModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ChannelPairingAttempt ||
    mongoose.model<IChannelPairingAttempt>('ChannelPairingAttempt', channelPairingAttemptSchema)
  );
}
