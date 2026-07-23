import viventiumGatewayIngressEventSchema from '~/schema/viventiumGatewayIngressEvent';
import type { IViventiumGatewayIngressEvent } from '~/types/channel';

export function createViventiumGatewayIngressEventModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ViventiumGatewayIngressEvent ||
    mongoose.model<IViventiumGatewayIngressEvent>(
      'ViventiumGatewayIngressEvent',
      viventiumGatewayIngressEventSchema,
    )
  );
}
