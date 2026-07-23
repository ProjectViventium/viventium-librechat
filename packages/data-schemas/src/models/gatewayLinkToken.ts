import gatewayLinkTokenSchema from '~/schema/gatewayLinkToken';
import type { IGatewayLinkToken } from '~/types/channel';

export function createGatewayLinkTokenModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.GatewayLinkToken ||
    mongoose.model<IGatewayLinkToken>('GatewayLinkToken', gatewayLinkTokenSchema)
  );
}
