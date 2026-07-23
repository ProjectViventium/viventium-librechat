import channelThreadSchema from '~/schema/channelThread';
import type { IChannelThread } from '~/types/channel';

export function createChannelThreadModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ChannelThread ||
    mongoose.model<IChannelThread>('ChannelThread', channelThreadSchema)
  );
}
