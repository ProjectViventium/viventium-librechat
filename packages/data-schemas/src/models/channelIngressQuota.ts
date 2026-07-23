import channelIngressQuotaSchema from '~/schema/channelIngressQuota';
import type { IChannelIngressQuota } from '~/types/channel';

export function createChannelIngressQuotaModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ChannelIngressQuota ||
    mongoose.model<IChannelIngressQuota>('ChannelIngressQuota', channelIngressQuotaSchema)
  );
}
