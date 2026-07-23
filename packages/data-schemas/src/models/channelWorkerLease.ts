import type { IChannelWorkerLease } from '~/types/channel';
import channelWorkerLeaseSchema from '~/schema/channelWorkerLease';

export function createChannelWorkerLeaseModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ChannelWorkerLease ||
    mongoose.model<IChannelWorkerLease>('ChannelWorkerLease', channelWorkerLeaseSchema)
  );
}
