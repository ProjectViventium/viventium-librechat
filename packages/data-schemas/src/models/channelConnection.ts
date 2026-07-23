import channelConnectionSchema from '~/schema/channelConnection';
import type { IChannelConnection } from '~/types/channel';

export function createChannelConnectionModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ChannelConnection ||
    mongoose.model<IChannelConnection>('ChannelConnection', channelConnectionSchema)
  );
}
