import channelPairingCodeSchema from '~/schema/channelPairingCode';
import type { IChannelPairingCode } from '~/types/channel';

export function createChannelPairingCodeModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ChannelPairingCode ||
    mongoose.model<IChannelPairingCode>('ChannelPairingCode', channelPairingCodeSchema)
  );
}
