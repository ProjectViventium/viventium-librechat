import gatewayUserMappingSchema from '~/schema/gatewayUserMapping';
import type { IGatewayUserMapping } from '~/types/channel';

export function createGatewayUserMappingModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.GatewayUserMapping ||
    mongoose.model<IGatewayUserMapping>('GatewayUserMapping', gatewayUserMappingSchema)
  );
}
