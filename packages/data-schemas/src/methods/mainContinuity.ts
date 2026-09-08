/* === VIVENTIUM START === Native Message owns accepted history; continuity owns derived state. === */
import { createHash } from 'crypto';
import { mainContinuityMessageEvidence } from './mainContinuityEvidence';
export { mainContinuityMessageEvidence } from './mainContinuityEvidence';
import type { FilterQuery } from 'mongoose';
import type { IMessage } from '~/types/message';
import type { IConversation } from '~/types/convo';
import type {
  IMainContinuityLegacyCursor,
  IMainContinuityAcceptedTurn,
  IMainSemanticCompaction,
  IViventiumMainContinuityState,
} from '~/types/mainContinuityState';

type Outcome = Record<string, unknown>;
type Transaction = <T>(operation: () => Promise<T>) => Promise<T>;
interface Identity {
  ownerId: string;
  agentId: string;
  continuityDomainId: string;
  stableAuthoritySha256?: string;
  contextEpoch?: string;
}
interface Turn {
  assistantMessageId: string;
  userMessageId: string;
  conversationId: string;
  logicalTurnId: string;
  revision: number;
  origin: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const mainContinuityStorageKey = (kind: string, domain: string, discriminator = '') =>
  digest(JSON.stringify(['main-continuity', 2, kind, domain, discriminator]));
const keyFor = mainContinuityStorageKey;
const recordFrom = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const provenanceFrom = (row: { metadata?: Record<string, unknown> }) =>
  recordFrom(row.metadata?.viventium);
const canonical = (value: unknown): unknown => {
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};

const sourceDigest = (row: Record<string, unknown> | null) => {
  if (!row) return '';
  const metadata = row.metadata as { viventium?: Record<string, unknown> } | undefined;
  const provenance = metadata?.viventium;
  return digest(
    JSON.stringify(
      canonical({
        user: row.user,
        conversationId: row.conversationId,
        parentMessageId: row.parentMessageId,
        isCreatedByUser: row.isCreatedByUser,
        evidence: mainContinuityMessageEvidence(row),
        files: row.files,
        error: row.error,
        unfinished: row.unfinished,
        mainContext: provenance?.mainContext,
        interactionContext: provenance?.interactionContext,
        visibility: provenance?.visibility,
      }),
    ),
  );
};

export function createMainContinuityMethods(mongoose: typeof import('mongoose')) {
  const messages = () => mongoose.model<IMessage>('Message');
  const conversations = () => mongoose.model<IConversation>('Conversation');
  const states = () =>
    mongoose.model<IViventiumMainContinuityState>('ViventiumMainContinuityState');
  let indexesReady: Promise<void> | undefined;

  async function ensureMainContinuityIndexes(): Promise<void> {
    if (!indexesReady)
      indexesReady = (async () => {
        const collection = states().collection;
        let indexes: Awaited<ReturnType<typeof collection.indexes>> = [];
        try {
          indexes = await collection.indexes();
        } catch (error) {
          if ((error as { code?: number }).code !== 26) throw error;
          indexes = [];
        }
        const legacy = indexes.find((index) => index.name === 'ownerId_1_agentId_1_contextEpoch_1');
        if (legacy) {
          if (
            !legacy.unique ||
            JSON.stringify(legacy.key) !==
              JSON.stringify({ ownerId: 1, agentId: 1, contextEpoch: 1 })
          )
            throw new Error('main_continuity_index_identity_mismatch');
          // Verify historical deterministic identity before retiring redundant uniqueness. Raw
          // driver operations deliberately stay outside any inherited presentation transaction.
          for await (const row of collection.find(
            { recordKind: { $exists: false } },
            {
              projection: {
                ownerId: 1,
                agentId: 1,
                continuityDomainId: 1,
                stableAuthoritySha256: 1,
                domainEpochKey: 1,
              },
            },
          )) {
            const domain = digest(
              JSON.stringify({ version: 1, ownerId: row.ownerId, agentId: row.agentId }),
            );
            if (
              row.continuityDomainId !== domain ||
              row.domainEpochKey !== digest(`${domain}\0${row.stableAuthoritySha256}`)
            )
              throw new Error('main_continuity_legacy_identity_mismatch');
          }
          await collection.createIndex({ domainEpochKey: 1 }, { unique: true });
          await collection.dropIndex(legacy.name!);
        }
        await collection.createIndex({ domainEpochKey: 1 }, { unique: true });
        await collection.createIndex({
          ownerId: 1,
          continuityDomainId: 1,
          recordKind: 1,
          domainEpochKey: 1,
        });
        await collection.createIndex({
          ownerId: 1,
          continuityDomainId: 1,
          recordKind: 1,
          'acceptedRevisions.logicalTurnId': 1,
        });
        for (const field of ['acceptedTurns.logicalTurnId', 'pendingCompactionTurns.logicalTurnId'])
          await collection.createIndex({
            ownerId: 1,
            continuityDomainId: 1,
            recordKind: 1,
            [field]: 1,
          });
        await messages().collection.createIndex(
          {
            user: 1,
            'acceptedMainContext.continuityDomainId': 1,
            'acceptedMainContext.position': 1,
          },
          { sparse: true },
        );
      })().catch((error) => {
        indexesReady = undefined;
        throw error;
      });
    return indexesReady;
  }

  const domainFilter = (identity: Identity) => ({
    domainEpochKey: keyFor('domain', identity.continuityDomainId),
    ownerId: identity.ownerId,
    agentId: identity.agentId,
    recordKind: 'domain',
  });
  const markerFilter = (identity: Identity) => ({
    user: identity.ownerId,
    'acceptedMainContext.continuityDomainId': identity.continuityDomainId,
  });

  async function ensureAcceptedMainDomain(identity: Identity) {
    if (
      identity.continuityDomainId !==
      digest(JSON.stringify({ version: 1, ownerId: identity.ownerId, agentId: identity.agentId }))
    )
      throw new Error('main_continuity_domain_identity_mismatch');
    await ensureMainContinuityIndexes();
    const filter = domainFilter(identity);
    const existing = await states().findOne(filter).lean();
    if (existing) return existing;
    // Classification preserves every historical byte. It runs only on first domain access;
    // epoch-local cursors later consume bounded immutable artifacts independently.
    await states().updateMany(
      {
        ownerId: identity.ownerId,
        continuityDomainId: identity.continuityDomainId,
        recordKind: { $exists: false },
      },
      { $set: { recordKind: 'legacy' } },
      { timestamps: false },
    );
    const legacyAvailable =
      Boolean(
        await states().exists({
          ownerId: identity.ownerId,
          continuityDomainId: identity.continuityDomainId,
          recordKind: 'legacy',
        }),
      ) ||
      Boolean(
        await messages().exists({
          ...markerFilter(identity),
          'acceptedMainContext.position': { $exists: false },
        }),
      );
    const row = await states()
      .findOneAndUpdate(
        filter,
        {
          $setOnInsert: {
            ...filter,
            continuityDomainId: identity.continuityDomainId,
            version: 1,
            acceptedPosition: 0,
            sourceGeneration: 0,
            legacyAvailable,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: false },
      )
      .lean();
    if (!row) throw new Error('main_continuity_domain_unavailable');
    return row;
  }

  async function lockDomain(identity: Identity) {
    await ensureAcceptedMainDomain(identity);
    const row = await states()
      .findOneAndUpdate(
        domainFilter(identity),
        { $inc: { version: 1 } },
        { new: true, timestamps: false },
      )
      .lean();
    if (!row) throw new Error('main_continuity_domain_unavailable');
    return row;
  }

  async function maximumRevision(
    identity: Identity,
    logicalTurnId: string,
    legacyAvailable: boolean,
  ) {
    const floor = await states()
      .findOne({
        domainEpochKey: keyFor('revision_floor', identity.continuityDomainId, logicalTurnId),
        ownerId: identity.ownerId,
        recordKind: 'revision_floor',
      })
      .lean();
    const marked = await messages()
      .findOne({ ...markerFilter(identity), 'acceptedMainContext.logicalTurnId': logicalTurnId })
      .select('+acceptedMainContext')
      .sort({ 'acceptedMainContext.revision': -1 })
      .lean();
    let revision = Math.max(floor?.revisionFloor || 0, marked?.acceptedMainContext?.revision || 0);
    // A deletion floor can predate legacy reconciliation and is not proof that all retained
    // branches were examined. Query only this indexed logical identity when legacy evidence exists.
    if (legacyAvailable) {
      const legacy = await states()
        .find({
          ownerId: identity.ownerId,
          continuityDomainId: identity.continuityDomainId,
          recordKind: 'legacy',
          $or: [
            { 'acceptedRevisions.logicalTurnId': logicalTurnId },
            { 'acceptedTurns.logicalTurnId': logicalTurnId },
            { 'pendingCompactionTurns.logicalTurnId': logicalTurnId },
          ],
        })
        .select('acceptedRevisions acceptedTurns pendingCompactionTurns')
        .lean();
      let legacyFloor = 0;
      for (const state of legacy)
        for (const item of [
          ...state.acceptedRevisions,
          ...state.acceptedTurns,
          ...state.pendingCompactionTurns,
        ])
          if (item.logicalTurnId === logicalTurnId)
            legacyFloor = Math.max(legacyFloor, item.revision);
      revision = Math.max(revision, legacyFloor);
      if (legacyFloor > 0) await retainFloor(identity, logicalTurnId, legacyFloor);
    }
    return revision;
  }

  async function retainFloor(
    identity: Identity,
    logicalTurnId: string,
    revision: number,
    deleted = false,
  ) {
    await states().updateOne(
      {
        domainEpochKey: keyFor('revision_floor', identity.continuityDomainId, logicalTurnId),
        ownerId: identity.ownerId,
        recordKind: 'revision_floor',
      },
      {
        $setOnInsert: {
          continuityDomainId: identity.continuityDomainId,
          agentId: identity.agentId,
          logicalTurnId,
          version: 1,
        },
        $max: { revisionFloor: revision, ...(deleted ? { deletedRevisionFloor: revision } : {}) },
      },
      { upsert: true, timestamps: false, setDefaultsOnInsert: false },
    );
  }

  async function lockSources(identity: Identity, turns: readonly Turn[]) {
    const seen = new Set<string>(),
      lockedConversations = new Set<string>();
    for (const turn of turns) {
      const filters = [
        {
          user: identity.ownerId,
          conversationId: turn.conversationId,
          messageId: turn.assistantMessageId,
          isCreatedByUser: { $ne: true },
          unfinished: { $ne: true },
          error: { $ne: true },
        },
        ...(turn.origin === 'scheduler'
          ? []
          : [
              {
                user: identity.ownerId,
                conversationId: turn.conversationId,
                messageId: turn.userMessageId,
                isCreatedByUser: true,
              },
            ]),
      ];
      for (const filter of filters) {
        if (seen.has(filter.messageId)) continue;
        seen.add(filter.messageId);
        const locked = await messages().updateOne(
          filter,
          { $inc: { __v: 1 } },
          { timestamps: false },
        );
        if (locked.matchedCount !== 1) return false;
      }
      if (lockedConversations.has(turn.conversationId)) continue;
      lockedConversations.add(turn.conversationId);
      const conversation = await conversations().updateOne(
        { user: identity.ownerId, conversationId: turn.conversationId },
        { $inc: { __v: 1 } },
        { timestamps: false },
      );
      if (conversation.matchedCount !== 1) return false;
    }
    return true;
  }

  async function runProjectionTransaction<T>(
    operation: () => Promise<T>,
    transaction: Transaction,
  ): Promise<T> {
    const inherited = (
      mongoose as unknown as {
        transactionAsyncLocalStorage?: {
          getStore: () => { session?: { inTransaction: () => boolean } } | undefined;
        };
      }
    ).transactionAsyncLocalStorage
      ?.getStore()
      ?.session?.inTransaction();
    if (inherited) return operation();
    for (let attempt = 0; ; attempt++) {
      try {
        return await transaction(operation);
      } catch (error) {
        const code = (error as { code?: number }).code;
        // These conflicts abort the DB transaction. Never replay an inherited owner's
        // transaction or retry an uncertain commit/transport result here.
        if (inherited || attempt >= 7 || (code !== 112 && code !== 11000)) throw error;
      }
    }
  }

  async function projectAcceptedMainPresentation(
    identity: Identity,
    turn: Turn,
    operation: () => Promise<Outcome>,
    transaction: Transaction,
  ): Promise<Outcome> {
    await ensureMainContinuityIndexes();
    return runProjectionTransaction(async () => {
      const domain = await lockDomain(identity);
      const prior = await maximumRevision(
        identity,
        turn.logicalTurnId,
        domain.legacyAvailable === true,
      );
      if (prior >= turn.revision) return { status: 'already_committed', acceptedRevision: prior };
      if (!(await lockSources(identity, [turn]))) return { status: 'not_accepted' };
      const result = await operation();
      if (result.status !== 'committed') return result;
      const position = Number(domain.acceptedPosition || 0) + 1;
      await states().updateOne(
        domainFilter(identity),
        {
          $set: { acceptedPosition: position },
          ...(prior > 0 ? { $inc: { sourceGeneration: 1 } } : {}),
        },
        { timestamps: false },
      );
      if (prior > 0)
        await messages().updateMany(
          {
            ...markerFilter(identity),
            'acceptedMainContext.logicalTurnId': turn.logicalTurnId,
            'acceptedMainContext.revision': { $lt: turn.revision },
          },
          { $set: { 'acceptedMainContext.supersededAt': new Date() } },
          { timestamps: false },
        );
      const marked = await messages().updateOne(
        {
          user: identity.ownerId,
          messageId: turn.assistantMessageId,
          conversationId: turn.conversationId,
        },
        {
          $set: {
            acceptedMainContext: {
              continuityDomainId: identity.continuityDomainId,
              logicalTurnId: turn.logicalTurnId,
              revision: turn.revision,
              committedAt: new Date(),
              position,
            },
          },
        },
        { timestamps: false },
      );
      if (marked.matchedCount !== 1) throw new Error('main_continuity_presentation_changed');
      return { ...result, version: position, compactionNeeded: true };
    }, transaction);
  }

  async function readAcceptedMainHistory(
    identity: Identity,
    options: { after?: number; through?: number; limit?: number; descending?: boolean } = {},
  ) {
    const domain = await ensureAcceptedMainDomain(identity);
    const through = Math.min(
      options.through ?? Number(domain.acceptedPosition || 0),
      Number(domain.acceptedPosition || 0),
    );
    const filter = {
      ...markerFilter(identity),
      'acceptedMainContext.supersededAt': { $exists: false },
      'acceptedMainContext.sourceDeletedAt': { $exists: false },
      'acceptedMainContext.position': { $gt: options.after || 0, $lte: through },
    };
    const rows = await messages()
      .find(filter)
      .select('messageId parentMessageId conversationId metadata +acceptedMainContext')
      .sort({ 'acceptedMainContext.position': options.descending ? -1 : 1 })
      .limit(Math.max(1, Math.min(options.limit || 64, 64)))
      .lean();
    const count = await messages().countDocuments(filter);
    return {
      position: Number(domain.acceptedPosition || 0),
      generation: Number(domain.sourceGeneration || 0),
      legacyAvailable: domain.legacyAvailable === true,
      count,
      turns: rows.map((row) => {
        const marker = row.acceptedMainContext!;
        const interaction = recordFrom(provenanceFrom(row).interactionContext);
        return {
          logicalTurnId: marker.logicalTurnId,
          revision: marker.revision,
          conversationId: row.conversationId,
          userMessageId: row.parentMessageId || '',
          assistantMessageId: row.messageId,
          origin: String(interaction?.origin || 'interactive'),
          scheduleId: String(interaction?.schedule_id || ''),
          scheduleRunId: String(interaction?.schedule_run_id || ''),
          userText: '',
          assistantText: '',
          toolPairs: [],
          committedAt: marker.committedAt,
          acceptedPosition: marker.position,
        };
      }),
    };
  }

  async function readLegacyMainInput(identity: Identity, cursor: IMainContinuityLegacyCursor = {}) {
    await ensureAcceptedMainDomain(identity);
    const offset = Math.max(0, Math.floor(cursor.range?.start ?? cursor.sourceOffset ?? 0));
    const limit = cursor.range ? cursor.range.end - offset : 64;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit < 0 || limit > 64)
      throw new Error('main_continuity_legacy_range_invalid');
    const allTurns = {
      $concatArrays: [
        { $ifNull: ['$pendingCompactionTurns', []] },
        { $ifNull: ['$acceptedTurns', []] },
      ],
    };
    const afterState = cursor.state ? { domainEpochKey: { $gt: cursor.state } } : {};
    const stateSelector = cursor.range ? { domainEpochKey: cursor.range.artifactId } : afterState;
    const [state] = await states().aggregate<{
      domainEpochKey: string;
      contextEpoch: string;
      semanticCompaction: IMainSemanticCompaction | null;
      sourceTurns: IMainContinuityAcceptedTurn[];
      sourceCount: number;
    }>([
      {
        $match: {
          ownerId: identity.ownerId,
          continuityDomainId: identity.continuityDomainId,
          recordKind: 'legacy',
          ...stateSelector,
        },
      },
      { $sort: { domainEpochKey: 1 } },
      { $limit: 1 },
      {
        $project: {
          domainEpochKey: 1,
          contextEpoch: 1,
          semanticCompaction: 1,
          sourceTurns: limit ? { $slice: [allTurns, offset, limit] } : { $literal: [] },
          sourceCount: { $size: allTurns },
        },
      },
    ]);
    if (state) {
      if (
        offset > state.sourceCount ||
        (cursor.range &&
          (cursor.range.total !== state.sourceCount || cursor.range.end > state.sourceCount))
      )
        throw new Error('main_continuity_legacy_range_changed');
      const sourceTurns = state.sourceTurns;
      const floors = await states()
        .find({
          ownerId: identity.ownerId,
          continuityDomainId: identity.continuityDomainId,
          recordKind: 'revision_floor',
          logicalTurnId: { $in: sourceTurns.map((turn) => turn.logicalTurnId) },
          deletedRevisionFloor: { $gt: 0 },
        })
        .select('logicalTurnId deletedRevisionFloor')
        .lean();
      const deletedThrough = new Map(
        floors.map((floor) => [floor.logicalTurnId, floor.deletedRevisionFloor || 0]),
      );
      const retiredSources = sourceTurns
        .filter(
          (turn) =>
            turn.sourceDeletedAt || (deletedThrough.get(turn.logicalTurnId) || 0) >= turn.revision,
        )
        .map((turn) => ({
          logicalTurnId: turn.logicalTurnId,
          revision: turn.revision,
          reason: 'source_deleted',
        }));
      return {
        artifact: {
          kind: 'legacy_state',
          id: state.domainEpochKey,
          contextEpoch: state.contextEpoch,
          semanticCompaction: state.semanticCompaction,
          sourceTurns,
          sourceRange: {
            artifactId: state.domainEpochKey,
            start: offset,
            end: offset + sourceTurns.length,
            total: state.sourceCount,
          },
          retiredSources,
          sourceOrder: 'original_record_order',
          sourceCoverage: 'not_proven_complete',
        },
        stateCursor: state.domainEpochKey,
        messageCursor: cursor.message || '',
        complete: false,
      };
    }
    const afterMessage = cursor.message
      ? { _id: { $gt: new mongoose.Types.ObjectId(cursor.message) } }
      : {};
    const requestedMessageId =
      cursor.range && mongoose.Types.ObjectId.isValid(cursor.range.artifactId)
        ? new mongoose.Types.ObjectId(cursor.range.artifactId)
        : null;
    const messageSelector = cursor.range ? { _id: requestedMessageId } : afterMessage;
    const rows = await messages()
      .find({
        ...markerFilter(identity),
        'acceptedMainContext.position': { $exists: false },
        'acceptedMainContext.supersededAt': { $exists: false },
        'acceptedMainContext.sourceDeletedAt': { $exists: false },
        ...messageSelector,
      })
      .select('messageId parentMessageId conversationId metadata +acceptedMainContext')
      .sort({ _id: 1 })
      .limit(1)
      .lean();
    const row = rows[0];
    if (!row)
      return {
        artifact: null,
        stateCursor: cursor.state || '',
        messageCursor: cursor.message || '',
        complete: !cursor.range,
      };
    if (
      cursor.range &&
      (cursor.range.start !== 0 || cursor.range.end !== 1 || cursor.range.total !== 1)
    )
      throw new Error('main_continuity_legacy_range_changed');
    const marker = row.acceptedMainContext!;
    return {
      artifact: {
        kind: 'legacy_presentation',
        id: row._id.toString(),
        sourceOrder: 'unknown_between_records',
        sourceRange: { artifactId: row._id.toString(), start: 0, end: 1, total: 1 },
        sourceTurns: [
          {
            logicalTurnId: marker.logicalTurnId,
            revision: marker.revision,
            conversationId: row.conversationId,
            userMessageId: row.parentMessageId || '',
            assistantMessageId: row.messageId,
            origin: String(
              recordFrom(provenanceFrom(row).interactionContext).origin || 'interactive',
            ),
            committedAt: marker.committedAt,
            userText: '',
            assistantText: '',
            toolPairs: [],
          },
        ],
      },
      stateCursor: cursor.state || '',
      messageCursor: row._id.toString(),
      complete: false,
    };
  }

  async function fenceAcceptedMainCompaction(
    identity: Identity,
    turns: readonly Turn[],
    operation: () => Promise<Outcome>,
    transaction: Transaction,
  ): Promise<Outcome> {
    await ensureMainContinuityIndexes();
    return runProjectionTransaction(async () => {
      await lockDomain(identity);
      if (!(await lockSources(identity, turns))) return { status: 'stale_source' };
      return operation();
    }, transaction);
  }

  async function mutateAcceptedMainContinuitySources<T>(
    filter: FilterQuery<IMessage>,
    operation: () => Promise<T>,
  ) {
    // This callback runs inside the existing source mutation transaction, never outside it.
    if (
      !(
        mongoose as unknown as {
          transactionAsyncLocalStorage?: {
            getStore: () =>
              | {
                  session?: { inTransaction: () => boolean };
                }
              | undefined;
          };
        }
      ).transactionAsyncLocalStorage
        ?.getStore()
        ?.session?.inTransaction()
    )
      throw new Error('main_continuity_mutation_transaction_required');
    const sources = await messages().find(filter).select('+acceptedMainContext').lean();
    if (!sources.length) return operation();
    const affected = await messages()
      .find({
        $or: sources.map((row) => ({
          user: row.user,
          $or: [{ _id: row._id }, { parentMessageId: row.messageId }],
        })),
        acceptedMainContext: { $exists: true },
      })
      .select('+acceptedMainContext')
      .lean();
    const domains = new Map<string, Identity>();
    for (const row of affected) {
      const marker = row.acceptedMainContext!;
      const agentId = String(recordFrom(provenanceFrom(row).mainContext).agentId || '');
      if (
        !agentId ||
        marker.continuityDomainId !==
          digest(JSON.stringify({ version: 1, ownerId: row.user, agentId }))
      )
        continue;
      domains.set(marker.continuityDomainId, {
        ownerId: row.user,
        agentId,
        continuityDomainId: marker.continuityDomainId,
      });
    }
    const legacy = await states()
      .find({
        recordKind: { $in: ['legacy', null] },
        $or: sources.map((row) => ({
          ownerId: row.user,
          $or: [
            { 'acceptedTurns.userMessageId': row.messageId },
            { 'acceptedTurns.assistantMessageId': row.messageId },
            { 'pendingCompactionTurns.userMessageId': row.messageId },
            { 'pendingCompactionTurns.assistantMessageId': row.messageId },
          ],
        })),
      })
      .lean();
    for (const state of legacy)
      domains.set(state.continuityDomainId, {
        ownerId: state.ownerId,
        agentId: state.agentId,
        continuityDomainId: state.continuityDomainId,
      });
    for (const identity of [...domains.values()].sort((a, b) =>
      a.continuityDomainId.localeCompare(b.continuityDomainId),
    ))
      await lockDomain(identity);
    const result = await operation();
    if (!sources.length) return result;
    const current = await messages()
      .find({ _id: { $in: sources.map((row) => row._id) } })
      .lean();
    const byId = new Map(current.map((row) => [row._id.toString(), row]));
    const changed = sources.filter(
      (row) =>
        sourceDigest(row as unknown as Record<string, unknown>) !==
        sourceDigest(
          (byId.get(row._id.toString()) || null) as unknown as Record<string, unknown> | null,
        ),
    );
    if (!changed.length) return result;
    const changedIds = new Set(changed.map((row) => row.messageId));
    const invalidated = new Set<string>();
    for (const row of affected) {
      if (!changedIds.has(row.messageId) && !changedIds.has(row.parentMessageId || '')) continue;
      const marker = row.acceptedMainContext!,
        identity = domains.get(marker.continuityDomainId)!;
      if (!identity || identity.ownerId !== row.user) continue;
      invalidated.add(identity.continuityDomainId);
      const deleted = changed.some(
        (source) =>
          (source.messageId === row.messageId || source.messageId === row.parentMessageId) &&
          !byId.has(source._id.toString()),
      );
      if (deleted) {
        await retainFloor(identity, marker.logicalTurnId, marker.revision, true);
        await messages().updateOne(
          { _id: row._id },
          { $set: { 'acceptedMainContext.sourceDeletedAt': new Date() } },
          { timestamps: false },
        );
      }
    }
    for (const state of legacy)
      for (const turn of [...state.acceptedTurns, ...state.pendingCompactionTurns]) {
        if (!changedIds.has(turn.userMessageId) && !changedIds.has(turn.assistantMessageId))
          continue;
        invalidated.add(state.continuityDomainId);
        const deleted = changed.some(
          (source) =>
            (source.messageId === turn.userMessageId ||
              source.messageId === turn.assistantMessageId) &&
            !byId.has(source._id.toString()),
        );
        if (deleted)
          await retainFloor(
            domains.get(state.continuityDomainId)!,
            turn.logicalTurnId,
            turn.revision,
            true,
          );
      }
    for (const domain of invalidated)
      await states().updateOne(
        domainFilter(domains.get(domain)!),
        { $inc: { sourceGeneration: 1 } },
        { timestamps: false },
      );
    return result;
  }

  return {
    ensureMainContinuityIndexes,
    ensureAcceptedMainDomain,
    projectAcceptedMainPresentation,
    readAcceptedMainHistory,
    readLegacyMainInput,
    fenceAcceptedMainCompaction,
    mutateAcceptedMainContinuitySources,
  };
}
export type MainContinuityMethods = ReturnType<typeof createMainContinuityMethods>;
/* === VIVENTIUM END === */
