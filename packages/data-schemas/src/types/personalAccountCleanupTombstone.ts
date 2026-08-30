export interface IPersonalAccountCleanupTombstone {
  contractVersion: 1;
  operationId: string;
  ownerScopeHash: string;
  reviewBindingSha256: string;
  preimageSha256: string;
  runNonceHash: string;
  tombstonedAt: Date;
}
