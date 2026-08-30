import localQaCortexFaultControlSchema, {
  localQaCortexFaultIssuanceSchema,
  localQaCortexFaultTerminalReceiptSchema,
} from '~/schema/localQaCortexFaultControl';
import type {
  ILocalQaCortexFaultControl,
  ILocalQaCortexFaultIssuance,
  ILocalQaCortexFaultTerminalReceipt,
} from '~/types/localQaCortexFaultControl';

export function createLocalQaCortexFaultControlModel(mongoose: typeof import('mongoose')) {
  if (!mongoose.models.LocalQaCortexFaultIssuance) {
    mongoose.model<ILocalQaCortexFaultIssuance>(
      'LocalQaCortexFaultIssuance',
      localQaCortexFaultIssuanceSchema,
    );
  }
  if (!mongoose.models.LocalQaCortexFaultTerminalReceipt) {
    mongoose.model<ILocalQaCortexFaultTerminalReceipt>(
      'LocalQaCortexFaultTerminalReceipt',
      localQaCortexFaultTerminalReceiptSchema,
    );
  }
  return (
    mongoose.models.LocalQaCortexFaultControl ||
    mongoose.model<ILocalQaCortexFaultControl>(
      'LocalQaCortexFaultControl',
      localQaCortexFaultControlSchema,
    )
  );
}
