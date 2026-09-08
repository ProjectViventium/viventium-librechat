/* === VIVENTIUM START === Native final persistence shares the source's Mongo transaction. === */
import { createHash } from 'node:crypto';
import { Constants, ContentTypes } from 'librechat-data-provider';
import { mainContinuityMessageEvidence } from './mainContinuityEvidence';
import type { FilterQuery } from 'mongoose';
import type { IMessage } from '~/types/message';
import type {
  NativeResponseAdmission,
  NativeResponseCandidate,
  NativeResponseCommit,
  NativeResponseIdentity,
  NativeResponseSource,
  NativeResponseMessageProjection,
  NativeResponseMutationKind,
} from '~/types/nativeResponse';

type Transaction = <T>(operation: () => Promise<T>) => Promise<T>;
type Commit = (identity: NativeResponseIdentity, digest: string) => Promise<NativeResponseCommit>;
type Revoke = (identity: NativeResponseIdentity) => Promise<NativeResponseCommit>;

/** BSON can retain absent optional values as null; identity semantics keep them absent. */
export function normalizeNativeResponseIdentity<T extends NativeResponseIdentity>(identity: T): T {
  if (!identity) return identity;
  const normalized = { ...identity };
  for (const key of [
    'sourceOrderScope',
    'sourceSequence',
    'deliveryDispositionRequired',
    'deliveryContext',
  ] as const) {
    if (normalized[key] == null) delete normalized[key];
  }
  if (normalized.source && normalized.source.parent == null) {
    normalized.source = { ...normalized.source };
    delete normalized.source.parent;
  }
  return normalized;
}

const metadataRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function nativeResponseDigest(value: unknown): string {
  return createHash('sha256').update(sortedJson(value)).digest('hex');
}

export function nativeResponseSource(
  row: Pick<IMessage, 'messageId' | 'text' | 'content' | 'files' | 'parentMessageId'> & {
    _id: { toString(): string };
  },
): NativeResponseSource {
  return {
    id: row._id.toString(),
    messageId: row.messageId,
    digest: nativeResponseDigest({
      text: row.text,
      content: row.content,
      files: row.files,
      parentMessageId: row.parentMessageId,
    }),
  };
}

/** One directly referenced authored parent; receipt/activity fields are not source evidence. */
export function nativeResponseParentSource(
  row: Pick<
    IMessage,
    | 'user'
    | 'conversationId'
    | 'messageId'
    | 'parentMessageId'
    | 'isCreatedByUser'
    | 'text'
    | 'content'
    | 'files'
  > & { _id: { toString(): string } },
): NonNullable<NativeResponseSource['parent']> {
  return {
    id: row._id.toString(),
    messageId: row.messageId,
    isCreatedByUser: row.isCreatedByUser === true,
    digest: nativeResponseDigest({
      user: row.user,
      conversationId: row.conversationId,
      parentMessageId: row.parentMessageId,
      isCreatedByUser: row.isCreatedByUser,
      evidence: mainContinuityMessageEvidence(row),
      files: row.files,
    }),
  };
}

export function createNativeResponseMethods(mongoose: typeof import('mongoose')) {
  const messages = () => mongoose.model<IMessage>('Message');
  async function ensureNativeResponseIndexes() {
    await messages().collection.createIndex(
      { 'nativeResponse.status': 1, 'nativeResponse.admittedAt': 1 },
      { sparse: true, name: 'viventium_native_response_recovery' },
    );
    await messages().collection.createIndex(
      { user: 1, 'nativeResponse.source.id': 1 },
      { sparse: true, name: 'viventium_native_response_source' },
    );
    await messages().collection.createIndex(
      { user: 1, 'nativeResponse.source.parent.id': 1 },
      { sparse: true, name: 'viventium_native_response_parent' },
    );
  }
  const responseFilter = (identity: NativeResponseIdentity) => ({
    user: identity.userId,
    conversationId: identity.conversationId,
    messageId: identity.responseMessageId,
    deletedAt: null,
    isCreatedByUser: false,
    'nativeResponse.invocationId': identity.invocationId,
    'nativeResponse.jobCreatedAt': identity.jobCreatedAt,
    'nativeResponse.bodySha256': identity.bodySha256,
  });

  async function lockSource(identity: NativeResponseIdentity, historical = false): Promise<void> {
    const source = await messages()
      .findOne({
        _id: identity.source.id,
        user: identity.userId,
        conversationId: identity.conversationId,
        messageId: identity.source.messageId,
        isCreatedByUser: true,
        deletedAt: null,
      })
      .lean();
    if (
      !source ||
      (!historical && nativeResponseSource(source).digest !== identity.source.digest)
    ) {
      throw new Error('native_response_source_changed');
    }
    const touched = await messages().updateOne(
      { _id: source._id, deletedAt: null },
      { $inc: { __v: 1 } },
      { timestamps: false },
    );
    if (touched.matchedCount !== 1) throw new Error('native_response_source_missing');
    const expectedParent = identity.source.parent;
    if (!expectedParent) return;
    const parent = await messages()
      .findOne({
        _id: expectedParent.id,
        user: identity.userId,
        conversationId: identity.conversationId,
        messageId: expectedParent.messageId,
        isCreatedByUser: expectedParent.isCreatedByUser === true,
        deletedAt: null,
      })
      .lean();
    if (
      source.parentMessageId !== expectedParent.messageId ||
      !parent ||
      (!historical && nativeResponseParentSource(parent).digest !== expectedParent.digest)
    )
      throw new Error('native_response_parent_changed');
    const parentTouched = await messages().updateOne(
      { _id: parent._id, deletedAt: null },
      { $inc: { __v: 1 } },
      { timestamps: false },
    );
    if (parentTouched.matchedCount !== 1) throw new Error('native_response_parent_missing');
  }

  async function nativeResponseSourceMatches(identity: NativeResponseIdentity): Promise<boolean> {
    const source = await messages().findOne({
      _id: identity.source.id, user: identity.userId, conversationId: identity.conversationId,
      messageId: identity.source.messageId, isCreatedByUser: true, deletedAt: null,
    }).lean();
    if (!source || nativeResponseSource(source).digest !== identity.source.digest) return false;
    const expected = identity.source.parent;
    if (!expected) return true;
    const parent = await messages().findOne({
      _id: expected.id, user: identity.userId, conversationId: identity.conversationId,
      messageId: expected.messageId, isCreatedByUser: expected.isCreatedByUser === true, deletedAt: null,
    }).lean();
    return Boolean(parent && source.parentMessageId === expected.messageId &&
      nativeResponseParentSource(parent).digest === expected.digest);
  }

  async function captureNativeResponseSource(
    userId: string,
    conversationId: string,
    messageId: string,
    parent?: NativeResponseSource['parent'] | null,
  ): Promise<NativeResponseSource> {
    const source = await messages()
      .findOne({ user: userId, conversationId, messageId, isCreatedByUser: true, deletedAt: null })
      .lean();
    if (!source) throw new Error('native_response_source_not_persisted');
    const proof = nativeResponseSource(source);
    // Explicit null declares that this new request has no selected history parent.
    // Omitted input retains byte-exact compatibility for existing callers/admissions.
    if (parent !== undefined) {
      const hasParent = Boolean(
        source.parentMessageId && source.parentMessageId !== Constants.NO_PARENT,
      );
      if (hasParent ? parent?.messageId !== source.parentMessageId : parent != null)
        throw new Error('native_response_parent_not_captured');
      if (parent) proof.parent = { ...parent };
    }
    return proof;
  }

  async function admitNativeResponse(
    identity: NativeResponseIdentity,
    transaction: Transaction,
  ): Promise<void> {
    identity = normalizeNativeResponseIdentity(identity);
    if (identity.recoverUntil <= Date.now()) throw new Error('native_response_expired');
    await transaction(async () => {
      await lockSource(identity);
      const existing = await messages()
        .findOne(responseFilter(identity))
        .select('+nativeResponse')
        .lean();
      if (existing?.nativeResponse) {
        const admission = existing.nativeResponse;
        if (
          admission.status !== 'pending' ||
          nativeResponseDigest(
            normalizeNativeResponseIdentity({ ...admission, status: undefined }),
          ) !== nativeResponseDigest(identity)
        ) {
          throw new Error('native_response_admission_conflict');
        }
        return;
      }
      const updated = await messages().updateOne(
        {
          user: identity.userId,
          conversationId: identity.conversationId,
          messageId: identity.responseMessageId,
          parentMessageId: identity.source.messageId,
          isCreatedByUser: false,
          deletedAt: null,
          unfinished: true,
          nativeResponse: { $exists: false },
        },
        { $set: { nativeResponse: { ...identity, status: 'pending' } } },
        { ignoreUndefined: true },
      );
      if (updated.modifiedCount !== 1) throw new Error('native_response_not_admitted');
    });
  }

  async function getNativeResponse(userId: string, responseMessageId: string) {
    return messages()
      .findOne({ user: userId, messageId: responseMessageId, deletedAt: null })
      .select('+nativeResponse')
      .lean();
  }

  async function prepareNativeResponse(
    identity: NativeResponseIdentity,
    candidate: NativeResponseCandidate,
    transaction: Transaction,
  ): Promise<string> {
    const candidateJson = JSON.stringify(candidate);
    const candidateSha256 = nativeResponseDigest(candidate);
    await transaction(async () => {
      await lockSource(identity);
      const row = await messages()
        .findOne(responseFilter(identity))
        .select('+nativeResponse')
        .lean();
      const admission = row?.nativeResponse;
      if (!admission || admission.recoverUntil <= Date.now())
        throw new Error('native_response_expired');
      if (['prepared', 'completed'].includes(admission.status)) {
        if (admission.candidateSha256 !== candidateSha256)
          throw new Error('native_response_candidate_conflict');
        return;
      }
      const saved = await messages().updateOne(
        { ...responseFilter(identity), 'nativeResponse.status': 'pending' },
        {
          $set: {
            'nativeResponse.status': 'prepared',
            'nativeResponse.candidateJson': candidateJson,
            'nativeResponse.candidateSha256': candidateSha256,
            'nativeResponse.authoritySha256': candidate.authoritySha256,
          },
        },
      );
      if (saved.modifiedCount !== 1) throw new Error('native_response_revoked');
    });
    return candidateSha256;
  }

  async function materializeNativeResponse(
    identity: NativeResponseIdentity,
    digest: string,
    commit: Commit,
    transaction: Transaction,
    projectMessage?: (
      candidate: NativeResponseCandidate,
      message: NativeResponseMessageProjection,
    ) => NativeResponseMessageProjection,
  ) {
    const committed = await commit(identity, digest);
    if (committed.status !== 'committed' || committed.candidateSha256 !== digest) {
      throw new Error('native_response_publication_revoked');
    }
    return transaction(async () => {
      const row = await messages()
        .findOne(responseFilter(identity))
        .select('+nativeResponse')
        .lean();
      const admission = row?.nativeResponse;
      if (!admission || admission.candidateSha256 !== digest)
        throw new Error('native_response_candidate_missing');
      if (admission.status === 'completed') return row;
      await lockSource(identity, admission.historicalPermit === digest);
      const candidate = JSON.parse(admission.candidateJson || '') as NativeResponseCandidate;
      const content: NativeResponseMessageProjection['content'] = [
        { type: 'text', text: candidate.text },
        ...(row.content || []).filter((part) => {
          const type = (part as { type?: string })?.type;
          return type !== 'text' && type !== 'error';
        }),
      ];
      const rawMessage: NativeResponseMessageProjection = {
        text: candidate.text,
        content,
        metadata: row.metadata,
      };
      const projected = projectMessage ? projectMessage(candidate, rawMessage) : rawMessage;
      const saved = await messages().findOneAndUpdate(
        {
          ...responseFilter(identity),
          'nativeResponse.status': 'prepared',
          'nativeResponse.candidateSha256': digest,
        },
        {
          $set: {
            text: projected.text,
            content: projected.content,
            unfinished: false,
            error: false,
            finish_reason: 'stop',
            'nativeResponse.status': 'completed',
            ...(projectMessage ? { metadata: projected.metadata } : {}),
          },
        },
        { new: true },
      );
      if (!saved) throw new Error('native_response_persistence_rejected');
      return saved.toObject();
    });
  }

  async function mutateNativeResponseSources<T>(
    filter: FilterQuery<IMessage>,
    mutate: () => Promise<T>,
    revoke: Revoke,
    transaction: Transaction,
    retire: (identity: NativeResponseIdentity) => Promise<void>,
    kind: NativeResponseMutationKind = 'edit',
  ): Promise<T> {
    if (kind === 'system') return mutate();
    // The supplied edit/delete writes these same source rows. Its transaction conflicts with
    // admission/preparation's lockSource; a retry sees any admission that won that race.
    return transaction(async () => {
      const sources = await messages().find(filter).select('_id user').lean();
      if (sources.length === 0) return mutate();
      const sourceIds = new Set(sources.map((source) => source._id.toString()));
      const sourcesByOwner = new Map<string, typeof sources>();
      for (const source of sources) {
        const owned = sourcesByOwner.get(String(source.user)) || [];
        owned.push(source);
        sourcesByOwner.set(String(source.user), owned);
      }
      const admissions = await messages()
        .find({
          deletedAt: null,
          $or: Array.from(sourcesByOwner, ([user, owned]) => ({
            user,
            $or: [
              {
                $and: [
                  {
                    $or: [
                      {
                        'nativeResponse.source.id': {
                          $in: owned.map((source) => source._id.toString()),
                        },
                      },
                      {
                        'nativeResponse.source.parent.id': {
                          $in: owned.map((source) => source._id.toString()),
                        },
                      },
                    ],
                  },
                  {
                    $or: [
                      { 'nativeResponse.status': { $in: ['pending', 'prepared'] } },
                      {
                        'nativeResponse.status': { $in: ['cancelled', 'failed'] },
                        $or: [
                          { 'nativeResponse.stopSnapshotStoredAt': { $gt: 0 } },
                          { 'nativeResponse.terminalSnapshotStoredAt': { $gt: 0 } },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                _id: { $in: owned.map((source) => source._id) },
                'nativeResponse.status': {
                  $in: ['pending', 'prepared', 'completed', 'cancelled', 'failed'],
                },
              },
            ],
          })),
        })
        .select('+nativeResponse')
        .lean();
      for (const response of admissions) {
        const admission = response.nativeResponse as NativeResponseAdmission;
        const assistantMutation = sourceIds.has(response._id.toString());
        const stopped = Boolean(
          admission.stopSnapshotStoredAt || admission.terminalSnapshotStoredAt,
        );
        if (assistantMutation || stopped) await retire(admission);
        const result: NativeResponseCommit =
          assistantMutation || stopped ? { status: 'revoked' } : await revoke(admission);
        if (result.status === 'unavailable')
          throw new Error('native_response_authority_unavailable');
        const update =
          !assistantMutation && result.status === 'committed' && result.candidateSha256
            ? { 'nativeResponse.historicalPermit': result.candidateSha256 }
            : { 'nativeResponse.status': 'cancelled', unfinished: false };
        await messages().updateOne(
          { _id: response._id, 'nativeResponse.invocationId': admission.invocationId },
          {
            $set: update,
            ...(stopped
              ? {
                  $unset: {
                    'nativeResponse.stopSnapshotStoredAt': '',
                    'nativeResponse.terminalSnapshotStoredAt': '',
                  },
                }
              : {}),
          },
        );
      }
      return mutate();
    });
  }

  async function settleNativeResponse(
    identity: NativeResponseIdentity,
    status: 'cancelled' | 'failed' | 'unsupported',
    snapshot?: NativeResponseMessageProjection,
  ) {
    const filter = {
      ...responseFilter(identity),
      'nativeResponse.status': { $in: ['pending', 'prepared'] },
    };
    if (snapshot) {
      if (
        status !== 'cancelled' ||
        typeof snapshot.text !== 'string' ||
        !Array.isArray(snapshot.content)
      )
        throw new Error('native_response_cancellation_snapshot_invalid');
      // Only a positively authorized Stop may persist its partial, in the same terminal write.
      return messages()
        .findOneAndUpdate(
          filter,
          {
            $set: {
              'nativeResponse.status': 'cancelled',
              'nativeResponse.stopSnapshotStoredAt': Date.now(),
              text: snapshot.text,
              content: snapshot.content,
              unfinished: true,
              error: false,
              finish_reason: 'incomplete',
              ...(snapshot.metadata !== undefined ? { metadata: snapshot.metadata } : {}),
            },
          },
          { new: true },
        )
        .lean();
    }
    return messages().updateOne(filter, {
      $set: { 'nativeResponse.status': status, unfinished: false, error: status !== 'cancelled' },
      ...(status === 'cancelled'
        ? {}
        : {
            $push: {
              content: {
                type: 'error',
                error_class: `native_response_${status}`,
                error:
                  status === 'unsupported'
                    ? 'This interrupted response requires its original conversation runtime.'
                    : 'The interrupted response could not be completed.',
              },
            },
          }),
    });
  }

  async function materializeNativeResponseTerminal(
    identity: NativeResponseIdentity,
    status: 'failed' | 'cancelled',
    authorize: (identity: NativeResponseIdentity) => Promise<boolean>,
    transaction: Transaction,
    project: (message: NativeResponseMessageProjection) => NativeResponseMessageProjection,
  ) {
    return transaction(async () => {
      const row = await messages()
        .findOne(responseFilter(identity))
        .select('+nativeResponse')
        .lean();
      const admission = row?.nativeResponse;
      if (
        !admission ||
        admission.recoverUntil <= Date.now() ||
        admission.stopSnapshotStoredAt !== undefined ||
        !['pending', 'prepared', 'failed', 'cancelled'].includes(admission.status)
      )
        return null;
      if (
        typeof admission.terminalSnapshotStoredAt === 'number' &&
        admission.terminalSnapshotStoredAt > 0
      )
        return row;
      if (admission.terminalSnapshotStoredAt !== undefined) return null;
      await lockSource(identity);
      if (!(await authorize(identity)))
        throw new Error('native_response_terminal_authority_unavailable');
      const projected = project({ text: row.text, content: row.content, metadata: row.metadata });
      const saved = await messages()
        .findOneAndUpdate(
          {
            ...responseFilter(identity),
            'nativeResponse.status': admission.status,
            'nativeResponse.stopSnapshotStoredAt': { $exists: false },
            'nativeResponse.terminalSnapshotStoredAt': { $exists: false },
          },
          {
            $set: {
              text: projected.text,
              content: [
                ...(projected.content || []).filter((part) => String(part.type) !== 'error'),
                {
                  type: 'error',
                  error_class: `native_response_${status}`,
                  error:
                    status === 'cancelled'
                      ? 'The response was cancelled before completion.'
                      : 'The response could not be completed.',
                },
              ],
              metadata: projected.metadata,
              error: true,
              unfinished: false,
              finish_reason: 'incomplete',
              'nativeResponse.status': status,
              'nativeResponse.terminalSnapshotStoredAt': Date.now(),
            },
          },
          { new: true },
        )
        .select('+nativeResponse')
        .lean();
      return saved;
    });
  }

  function listNativeResponses(limit = 100) {
    return messages()
      .find({
        deletedAt: null,
        $or: [
          { 'nativeResponse.status': { $in: ['pending', 'prepared'] } },
          {
            'nativeResponse.status': { $in: ['failed', 'cancelled'] },
            'nativeResponse.finalReplayStoredAt': { $exists: false },
            'nativeResponse.recoverUntil': { $gt: Date.now() },
          },
          {
            $or: [
              { 'nativeResponse.status': 'completed' },
              {
                'nativeResponse.status': 'cancelled',
                'nativeResponse.stopSnapshotStoredAt': { $gt: 0 },
              },
            ],
            'nativeResponse.finalReplayStoredAt': { $exists: false },
            'nativeResponse.recoverUntil': { $gt: Date.now() },
          },
        ],
      })
      .select('+nativeResponse')
      .sort({ 'nativeResponse.admittedAt': 1 })
      .limit(limit)
      .lean();
  }

  async function markNativeResponseReplayStored(identity: NativeResponseIdentity) {
    const result = await messages().updateOne(
      {
        ...responseFilter(identity),
        $or: [
          { 'nativeResponse.status': 'completed' },
          {
            'nativeResponse.status': { $in: ['failed', 'cancelled'] },
            'nativeResponse.terminalSnapshotStoredAt': { $gt: 0 },
          },
          {
            'nativeResponse.status': 'cancelled',
            'nativeResponse.stopSnapshotStoredAt': { $gt: 0 },
          },
        ],
        'nativeResponse.finalReplayStoredAt': { $exists: false },
      },
      { $set: { 'nativeResponse.finalReplayStoredAt': Date.now() } },
    );
    if (result.matchedCount === 1) return true;
    return !!(await messages().exists({
      ...responseFilter(identity),
      $or: [
        { 'nativeResponse.status': 'completed' },
        {
          'nativeResponse.status': { $in: ['failed', 'cancelled'] },
          'nativeResponse.terminalSnapshotStoredAt': { $gt: 0 },
        },
        { 'nativeResponse.status': 'cancelled', 'nativeResponse.stopSnapshotStoredAt': { $gt: 0 } },
      ],
      'nativeResponse.finalReplayStoredAt': { $exists: true },
    }));
  }

  async function saveNativeResponseSnapshot(
    userId: string,
    update: Partial<IMessage>,
    expected?: NativeResponseIdentity,
    mode: 'snapshot' | 'augmentation' = 'snapshot',
  ) {
    const row = await getNativeResponse(userId, String(update.messageId || ''));
    if (expected?.responseMessageId === update.messageId && !row) {
      throw new Error('native_response_message_deleted');
    }
    const admission = row?.nativeResponse;
    if (!row || !admission || admission.status === 'unsupported') return undefined;
    const visibleRow = { ...row };
    delete visibleRow.nativeResponse;
    delete visibleRow.savedMemoryWrite;
    const terminalAugmentation =
      mode === 'augmentation' && ['cancelled', 'failed'].includes(admission.status);
    if (
      admission.status !== 'pending' &&
      admission.status !== 'completed' &&
      !(mode === 'augmentation' && admission.status === 'prepared') &&
      !terminalAugmentation
    )
      return visibleRow;
    if (mode === 'snapshot' && admission.status === 'pending' && update.unfinished !== true)
      return visibleRow;
    const guarded = { ...update, unfinished: row.unfinished };
    if (mode === 'snapshot' && Array.isArray(update.content)) {
      // Background augmentation owns these rows. A foreground snapshot may predate their
      // activation or completion, so it cannot remove or regress an already persisted result.
      const cortexTypes = new Set([
        ContentTypes.CORTEX_ACTIVATION, ContentTypes.CORTEX_BREWING, ContentTypes.CORTEX_INSIGHT,
      ]);
      const savedCortices = (row.content || []).filter((part) => cortexTypes.has(part.type));
      const savedIds = new Set(savedCortices.map((part) => part.cortex_id));
      guarded.content = [
        ...update.content.filter((part) => !cortexTypes.has(part.type) || !savedIds.has(part.cortex_id)),
        ...savedCortices,
      ];
    }
    delete guarded.nativeResponse;
    delete guarded.savedMemoryWrite;
    if (admission.status === 'completed' || terminalAugmentation) {
      if (update.metadata !== undefined) {
        const savedViventium = metadataRecord(row.metadata?.viventium);
        const viventium = { ...savedViventium, ...metadataRecord(update.metadata?.viventium) };
        for (const key of ['deliveryDisposition', 'nativeToolEvidence']) {
          if (Object.prototype.hasOwnProperty.call(savedViventium, key)) {
            viventium[key] = savedViventium[key];
          } else {
            delete viventium[key];
          }
        }
        guarded.metadata = { ...row.metadata, ...update.metadata, viventium };
      }
      guarded.text = row.text;
      guarded.error = row.error;
      guarded.finish_reason = row.finish_reason;
      guarded.content = [
        { type: 'text', text: row.text || '' },
        ...(terminalAugmentation
          ? (row.content || []).filter((part) => String(part.type) === 'error')
          : []),
        ...(guarded.content || row.content || []).filter(
          (part) => !['text', 'error'].includes(String((part as { type?: string })?.type)),
        ),
      ];
    }
    const saved = await messages().findOneAndUpdate(
      { ...responseFilter(admission), 'nativeResponse.status': admission.status },
      { $set: guarded },
      { new: true },
    );
    if (saved) return saved.toObject();
    const winner = await getNativeResponse(userId, String(update.messageId));
    if (!winner) throw new Error('native_response_message_deleted');
    const visibleWinner = { ...winner };
    delete visibleWinner.nativeResponse;
    delete visibleWinner.savedMemoryWrite;
    return visibleWinner;
  }

  return {
    captureNativeResponseSource,
    nativeResponseSourceMatches,
    admitNativeResponse,
    getNativeResponse,
    prepareNativeResponse,
    materializeNativeResponse,
    materializeNativeResponseTerminal,
    mutateNativeResponseSources,
    settleNativeResponse,
    listNativeResponses,
    markNativeResponseReplayStored,
    saveNativeResponseSnapshot,
    ensureNativeResponseIndexes,
  };
}
/* === VIVENTIUM END === */
