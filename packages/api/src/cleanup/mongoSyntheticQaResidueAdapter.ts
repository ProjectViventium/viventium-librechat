import type { Model } from 'mongoose';
import type { IMessage } from '@librechat/data-schemas';
import type { SyntheticQaResidueAdapter } from './types';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(String(value || '')) || ['all', '*', '.', '..'].includes(value)) {
    throw new Error(`${label}_invalid`);
  }
}

/** Query only server-owned structured QA provenance; never inspect or match user text. */
export function createMongoSyntheticQaResidueAdapter(
  Message: Model<IMessage>,
): SyntheticQaResidueAdapter {
  return {
    async verifyNonceAbsent({ ownerId, runNonce }) {
      requireSafeId(ownerId, 'cleanup_residue_owner');
      requireSafeId(runNonce, 'cleanup_residue_nonce');
      const activeMessageCount = await Message.countDocuments({
        user: ownerId,
        deletedAt: null,
        'metadata.viventium.qaRun': true,
        'metadata.viventium.qaRunId': runNonce,
      });
      return {
        verified: activeMessageCount === 0,
        activeMessageCount,
      };
    },
  };
}
