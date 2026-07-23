import type { IChannelDelivery } from '~/types/channel';
import channelDeliverySchema from '~/schema/channelDelivery';

export function createChannelDeliveryModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ChannelDelivery ||
    mongoose.model<IChannelDelivery>('ChannelDelivery', channelDeliverySchema)
  );
}
