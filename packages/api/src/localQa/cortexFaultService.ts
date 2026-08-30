/* === VIVENTIUM START ===
 * Feature: EMO-UC-048 deterministic local-QA fault controls.
 * Purpose: Adapt the typed control contract to one durable Mongo projection and audit row.
 * === VIVENTIUM END === */

import { createCortexLocalQaFaultControlManager } from './cortexFaultControl';
import type { CortexLocalQaFaultBoundary, CortexLocalQaFaultState } from '@librechat/data-schemas';
import type {
  CortexLocalQaFaultClearQuery,
  CortexLocalQaFaultConsumeQuery,
  CortexLocalQaFaultControlRow,
  CortexLocalQaFaultControlStore,
  CortexLocalQaFaultExpireQuery,
  CortexLocalQaFaultScopeQuery,
  CortexLocalQaSyntheticScopeVerification,
} from './cortexFaultControl';

type FaultTerminalState = Exclude<CortexLocalQaFaultState, 'armed'>;
type FaultTransitionQuery =
  CortexLocalQaFaultConsumeQuery | CortexLocalQaFaultExpireQuery | CortexLocalQaFaultClearQuery;

interface FaultBindingRecord {
  schemaVersion: 1;
  controlId: string;
  capabilityKey: string;
  caseTokenHash: string;
  componentArtifactDigest: string;
  boundary: CortexLocalQaFaultBoundary;
  ownerScopeHash: string;
  conversationScopeHash: string;
  parentScopeHash: string;
  syntheticScope: true;
  armedAt: Date | string;
  expiresAt: Date | string;
  purgeAt: Date | string;
}

interface FaultAuditRecord {
  sequence: number;
  event: CortexLocalQaFaultState;
  at: Date | string | null;
}

interface FaultProjectionRecord extends FaultBindingRecord {
  _id?: object | string;
  state: CortexLocalQaFaultState | 'inconsistent';
  inconsistency?: 'control_projection_missing';
  consumedAt?: Date | string | null;
  clearedAt?: Date | string | null;
  audit: FaultAuditRecord[];
  toObject?: () => FaultProjectionRecord;
}

interface FaultAuthorityRecord extends FaultBindingRecord {
  authorityState: CortexLocalQaFaultState;
  terminalAt?: Date | string | null;
}

interface FaultTransitionRecord extends FaultBindingRecord {
  state: 'armed';
  terminalState: FaultTerminalState;
  terminalAt: Date;
}

interface FindOneQuery<T> extends PromiseLike<T | null> {
  lean(): Promise<T | null>;
  select(selection: object): FindOneQuery<T>;
}

interface FindManyQuery<T> extends PromiseLike<T[]> {
  sort(sort: object): FindManyQuery<T>;
  lean(): Promise<T[]>;
}

interface ReplaceOneCollection {
  replaceOne(filter: object, replacement: object, options?: object): PromiseLike<unknown>;
}

interface FaultIssuanceModel {
  create(value: object): Promise<FaultAuthorityRecord>;
  findOne(filter: object): FindOneQuery<FaultAuthorityRecord>;
  find(filter: object): FindManyQuery<FaultAuthorityRecord>;
  findOneAndUpdate(
    filter: object,
    update: object,
    options: object,
  ): Promise<FaultAuthorityRecord | null>;
}

interface FaultTerminalReceiptModel {
  collection: ReplaceOneCollection;
}

interface FaultControlDatabase {
  model(name: 'LocalQaCortexFaultIssuance'): FaultIssuanceModel;
  model(name: 'LocalQaCortexFaultTerminalReceipt'): FaultTerminalReceiptModel;
}

interface FaultControlModel {
  db: FaultControlDatabase;
  collection: ReplaceOneCollection;
  create(value: object): Promise<FaultProjectionRecord>;
  findOne(filter: object): FindOneQuery<FaultProjectionRecord>;
  findOneAndUpdate(
    filter: object,
    update: object,
    options: object,
  ): Promise<FaultProjectionRecord | null>;
}

interface FixtureUserRecord {
  _id: object | string;
  email?: string;
  provider?: string;
  idOnTheSource?: string;
  expiresAt?: Date | string;
}

interface FixtureConversationRecord {
  user?: object | string;
  conversationId?: string;
  tags?: string[];
  expiredAt?: Date | string;
}

interface LocalQaFixtureMarker {
  schemaVersion?: number;
  caseId?: string;
  componentArtifactDigest?: string;
  caseTokenHash?: string;
  ownerScopeHash?: string;
  conversationScopeHash?: string;
  parentScopeHash?: string;
  expiresAt?: Date | string;
}

interface FixtureMessageRecord {
  user?: object | string;
  conversationId?: string;
  messageId?: string;
  isCreatedByUser?: boolean;
  expiredAt?: Date | string;
  metadata?: { viventium?: { localQaFixture?: LocalQaFixtureMarker } };
}

interface FixtureModel<T> {
  findOne(filter: object): FindOneQuery<T>;
}

interface FixtureModels {
  User?: FixtureModel<FixtureUserRecord>;
  Conversation?: FixtureModel<FixtureConversationRecord>;
  Message?: FixtureModel<FixtureMessageRecord>;
}

export interface LocalQaCortexFaultServiceOptions {
  ControlModel?: FaultControlModel;
  UserModel?: FixtureModel<FixtureUserRecord>;
  ConversationModel?: FixtureModel<FixtureConversationRecord>;
  MessageModel?: FixtureModel<FixtureMessageRecord>;
  modelProvider?: () => FaultControlModel;
  fixtureModelProvider?: () => FixtureModels;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  randomUUID?: () => string;
}

export const FIXTURE_CASE_ID = 'emo_uc_048';
export const FIXTURE_PROVIDER = 'viventium_local_qa_fixture';
export const FIXTURE_TAG = 'viventium:local-qa:emo_uc_048';
const FIXTURE_OWNER_EMAIL = /^emo-uc-048-[a-f0-9]{32}@local-qa\.invalid$/;
const FIXTURE_CONVERSATION_ID = /^emo_uc_048_conversation_[a-f0-9]{32}$/;
const FIXTURE_PARENT_ID = /^emo_uc_048_parent_[a-f0-9]{32}$/;
const SHA256_HASH = /^sha256:[a-f0-9]{64}$/;
const ISO_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/;
export const COMPONENT_ARTIFACT_DIGEST_ENV = 'VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST';
const FIXTURE_METADATA_KEYS = new Set([
  'schemaVersion',
  'caseId',
  'componentArtifactDigest',
  'caseTokenHash',
  'ownerScopeHash',
  'conversationScopeHash',
  'parentScopeHash',
  'expiresAt',
]);

function missingModelProvider(): never {
  throw new Error('local_qa_cortex_fault_models_unavailable');
}

function runtimeDate(value: Date | string | number | null | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return new Date(value === null ? 0 : Number.NaN);
}

function dateIso(value: Date | string | number | null | undefined): string {
  const date = runtimeDate(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace(/Z$/, '+00:00') : '';
}

function isCanonicalTimestamp(value: unknown): boolean {
  const rendered = typeof value === 'string' ? value : '';
  return ISO_MILLIS_PATTERN.test(rendered) && dateIso(rendered) === rendered;
}

function toRow(value: FaultProjectionRecord): CortexLocalQaFaultControlRow;
function toRow(value: null | undefined): null;
function toRow(
  value: FaultProjectionRecord | null | undefined,
): CortexLocalQaFaultControlRow | null;
function toRow(
  value: FaultProjectionRecord | null | undefined,
): CortexLocalQaFaultControlRow | null {
  if (!value) return null;
  const row = typeof value.toObject === 'function' ? value.toObject() : value;
  return {
    schemaVersion: row.schemaVersion,
    controlId: row.controlId,
    capabilityKey: row.capabilityKey,
    caseTokenHash: row.caseTokenHash,
    componentArtifactDigest: row.componentArtifactDigest,
    boundary: row.boundary,
    ownerScopeHash: row.ownerScopeHash,
    conversationScopeHash: row.conversationScopeHash,
    parentScopeHash: row.parentScopeHash,
    syntheticScope: row.syntheticScope,
    state: row.state,
    ...(row.inconsistency ? { inconsistency: row.inconsistency } : {}),
    armedAt: dateIso(row.armedAt),
    expiresAt: dateIso(row.expiresAt),
    purgeAt: dateIso(row.purgeAt),
    ...(row.consumedAt ? { consumedAt: dateIso(row.consumedAt) } : {}),
    ...(row.clearedAt ? { clearedAt: dateIso(row.clearedAt) } : {}),
    audit: (Array.isArray(row.audit) ? row.audit : []).map((event) => ({
      sequence: event.sequence,
      event: event.event,
      at: dateIso(event.at),
    })),
  };
}

function exactKeys(
  value: unknown,
  expected: ReadonlySet<string>,
): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key)),
  );
}

function dateCovers(value: unknown, expected: Date): boolean {
  const actual = runtimeDate(
    value instanceof Date ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      value === null
      ? value
      : undefined,
  );
  return Number.isFinite(actual.getTime()) && actual.getTime() >= expected.getTime();
}

function createMongoFaultControlStore(
  getControlModel: () => FaultControlModel,
): CortexLocalQaFaultControlStore {
  function privateModels(Control: FaultControlModel): {
    Issuance: FaultIssuanceModel;
    TerminalReceipt: FaultTerminalReceiptModel;
  } {
    return {
      Issuance: Control.db.model('LocalQaCortexFaultIssuance'),
      TerminalReceipt: Control.db.model('LocalQaCortexFaultTerminalReceipt'),
    };
  }

  function exactIdentity(value: FaultBindingRecord): FaultBindingRecord {
    return {
      schemaVersion: 1,
      controlId: value.controlId,
      capabilityKey: value.capabilityKey,
      caseTokenHash: value.caseTokenHash,
      componentArtifactDigest: value.componentArtifactDigest,
      boundary: value.boundary,
      ownerScopeHash: value.ownerScopeHash,
      conversationScopeHash: value.conversationScopeHash,
      parentScopeHash: value.parentScopeHash,
      syntheticScope: true,
      armedAt: new Date(value.armedAt),
      expiresAt: new Date(value.expiresAt),
      purgeAt: new Date(value.purgeAt),
    };
  }

  function duplicate(error: unknown): boolean {
    return Boolean(
      error && typeof error === 'object' && Number((error as { code?: unknown }).code) === 11000,
    );
  }

  function duplicateAuthority() {
    return Object.assign(new Error('local_qa_cortex_fault_authority_exists'), { code: 11000 });
  }

  function sameBinding(left: FaultBindingRecord, right: FaultBindingRecord): boolean {
    return (
      left.schemaVersion === 1 &&
      left.capabilityKey === right.capabilityKey &&
      left.caseTokenHash === right.caseTokenHash &&
      left.componentArtifactDigest === right.componentArtifactDigest &&
      left.boundary === right.boundary &&
      left.ownerScopeHash === right.ownerScopeHash &&
      left.conversationScopeHash === right.conversationScopeHash &&
      left.parentScopeHash === right.parentScopeHash &&
      left.syntheticScope === true
    );
  }

  function projectionFromAuthority(
    authority: FaultAuthorityRecord,
    state: CortexLocalQaFaultState = authority.authorityState,
  ): FaultProjectionRecord {
    const identity = exactIdentity(authority);
    const terminalAt = authority.terminalAt ? new Date(authority.terminalAt) : null;
    return {
      ...identity,
      state,
      ...(state === 'consumed' ? { consumedAt: terminalAt } : {}),
      ...(state === 'cleared' ? { clearedAt: terminalAt } : {}),
      audit: [
        { sequence: 1, event: 'armed', at: identity.armedAt },
        ...(state === 'armed' ? [] : [{ sequence: 2, event: state, at: terminalAt }]),
      ],
    };
  }

  function rowFromAuthority(
    authority: FaultAuthorityRecord,
    state: CortexLocalQaFaultState | 'inconsistent' = authority.authorityState,
  ): CortexLocalQaFaultControlRow {
    return toRow({
      ...projectionFromAuthority(authority, state === 'inconsistent' ? 'armed' : state),
      state,
      ...(state === 'inconsistent' ? { inconsistency: 'control_projection_missing' } : {}),
    });
  }

  function validArmedProjection(
    value: FaultProjectionRecord | null | undefined,
  ): value is FaultProjectionRecord {
    const row = toRow(value);
    return Boolean(
      row &&
      row.state === 'armed' &&
      row.audit.length === 1 &&
      row.audit[0].sequence === 1 &&
      row.audit[0].event === 'armed' &&
      row.audit[0].at === row.armedAt &&
      !row.consumedAt &&
      !row.clearedAt,
    );
  }

  async function repairArmedProjection(
    Control: FaultControlModel,
    authority: FaultAuthorityRecord,
    authorityCreated: boolean,
  ): Promise<CortexLocalQaFaultControlRow> {
    const identity = exactIdentity(authority);
    const projection = projectionFromAuthority(authority, 'armed');
    if (authorityCreated) {
      try {
        return toRow(await Control.create(projection));
      } catch (error) {
        if (!duplicate(error)) throw error;
      }
    }

    const exact = await Control.findOne(identity);
    if (validArmedProjection(exact)) return toRow(exact);

    const conflicting = await Control.findOne({
      $or: [
        { capabilityKey: authority.capabilityKey },
        {
          caseTokenHash: authority.caseTokenHash,
          componentArtifactDigest: authority.componentArtifactDigest,
          boundary: authority.boundary,
          ownerScopeHash: authority.ownerScopeHash,
          conversationScopeHash: authority.conversationScopeHash,
          parentScopeHash: authority.parentScopeHash,
        },
      ],
    }).lean();
    if (conflicting) {
      await Control.collection.replaceOne({ _id: conflicting._id }, projection);
    } else {
      await Control.create(projection);
    }
    const repaired = await Control.findOne(identity);
    if (!validArmedProjection(repaired)) {
      throw new Error('local_qa_cortex_fault_projection_repair_failed');
    }
    return toRow(repaired);
  }

  function mongoTransition(
    query: FaultTransitionQuery,
    terminalState: FaultTerminalState,
  ): FaultTransitionRecord {
    return {
      schemaVersion: 1,
      controlId: query.controlId,
      capabilityKey: query.capabilityKey,
      caseTokenHash: query.caseTokenHash,
      componentArtifactDigest: query.componentArtifactDigest,
      boundary: query.boundary,
      ownerScopeHash: query.ownerScopeHash,
      conversationScopeHash: query.conversationScopeHash,
      parentScopeHash: query.parentScopeHash,
      syntheticScope: true,
      state: 'armed',
      armedAt: new Date(query.armedAt),
      expiresAt: new Date(query.expiresAt),
      purgeAt: new Date(query.purgeAt),
      terminalState,
      terminalAt: new Date(query.at),
    };
  }

  async function writeTerminalEvidence(
    Control: FaultControlModel,
    TerminalReceipt: FaultTerminalReceiptModel,
    authority: FaultAuthorityRecord,
  ): Promise<void> {
    const terminalState = authority.authorityState;
    const terminalAt = runtimeDate(authority.terminalAt);
    const identity = exactIdentity(authority);
    const projection = projectionFromAuthority(authority, terminalState);
    const receipt = { ...identity, terminalState, terminalAt };
    const controlFilter = {
      ...identity,
      state: 'armed',
      expiresAt: {
        $eq: identity.expiresAt,
        ...(terminalState === 'expired' ? { $lte: terminalAt } : { $gt: terminalAt }),
      },
    };
    let update: {
      $set:
        | { state: 'expired' }
        | { state: 'consumed'; consumedAt: Date }
        | { state: 'cleared'; clearedAt: Date };
    } = { $set: { state: 'expired' } };
    if (terminalState === 'consumed') {
      update = { $set: { state: 'consumed', consumedAt: terminalAt } };
    } else if (terminalState === 'cleared') {
      update = { $set: { state: 'cleared', clearedAt: terminalAt } };
    }
    const evidenceWrites = [
      TerminalReceipt.collection.replaceOne({ capabilityKey: authority.capabilityKey }, receipt, {
        upsert: true,
      }),
      (async () => {
        const updated = await Control.findOneAndUpdate(
          controlFilter,
          {
            ...update,
            $push: { audit: { sequence: 2, event: terminalState, at: terminalAt } },
          },
          { new: true, runValidators: true },
        );
        if (!updated) {
          await Control.collection.replaceOne(
            { capabilityKey: authority.capabilityKey },
            projection,
            { upsert: true },
          );
        }
      })(),
    ];
    await Promise.allSettled(evidenceWrites);
  }

  async function transition(
    Control: FaultControlModel,
    query: FaultTransitionQuery,
    terminalState: FaultTerminalState,
  ): Promise<CortexLocalQaFaultControlRow | null> {
    const { Issuance, TerminalReceipt } = privateModels(Control);
    const transition = mongoTransition(query, terminalState);
    const identity = exactIdentity(transition);
    const authority = await Issuance.findOneAndUpdate(
      {
        ...identity,
        authorityState: 'armed',
        expiresAt: {
          $eq: transition.expiresAt,
          ...(terminalState === 'expired'
            ? { $lte: transition.terminalAt }
            : { $gt: transition.terminalAt }),
        },
      },
      {
        $set: { authorityState: terminalState, terminalAt: transition.terminalAt },
      },
      { new: true, runValidators: true },
    );
    if (!authority) return null;
    await writeTerminalEvidence(Control, TerminalReceipt, authority);
    return rowFromAuthority(authority);
  }

  return {
    async insert(row) {
      const Control = getControlModel();
      const { Issuance } = privateModels(Control);
      const identity = exactIdentity(row);
      let authority: FaultAuthorityRecord;
      let authorityCreated = true;
      try {
        authority = await Issuance.create({ ...identity, authorityState: 'armed' });
      } catch (error) {
        if (!duplicate(error)) throw error;
        authorityCreated = false;
        const existing = await Issuance.findOne({ capabilityKey: row.capabilityKey }).lean();
        if (!existing || !sameBinding(existing, row) || existing.authorityState !== 'armed') {
          throw duplicateAuthority();
        }
        authority = existing;
      }
      return repairArmedProjection(Control, authority, authorityCreated);
    },
    async consume(query) {
      const Control = getControlModel();
      return toRow(await transition(Control, query, 'consumed'));
    },
    async expire(query) {
      const Control = getControlModel();
      const result = await transition(Control, query, 'expired');
      return result ? 1 : 0;
    },
    async clear(query) {
      const Control = getControlModel();
      const result = await transition(Control, query, 'cleared');
      return result ? 1 : 0;
    },
    async list(query: CortexLocalQaFaultScopeQuery) {
      const Control = getControlModel();
      const { Issuance } = privateModels(Control);
      const issuances = await Issuance.find({
        caseTokenHash: query.caseTokenHash,
        componentArtifactDigest: query.componentArtifactDigest,
        ownerScopeHash: query.ownerScopeHash,
        conversationScopeHash: query.conversationScopeHash,
        parentScopeHash: query.parentScopeHash,
        ...(query.boundary ? { boundary: query.boundary } : {}),
      })
        .sort({ armedAt: 1, controlId: 1 })
        .lean();
      const rows = await Promise.all(
        issuances.map(async (issuance: FaultAuthorityRecord) => {
          if (['consumed', 'cleared', 'expired'].includes(issuance.authorityState)) {
            return rowFromAuthority(issuance);
          }
          if (issuance.authorityState !== 'armed') return null;
          const control = await Control.findOne(exactIdentity(issuance));
          if (validArmedProjection(control)) return toRow(control);
          return rowFromAuthority(issuance, 'inconsistent');
        }),
      );
      return rows.filter((row): row is CortexLocalQaFaultControlRow => row !== null);
    },
  };
}

export function createMongoSyntheticScopeVerifier(
  getFixtureModels: () => FixtureModels,
  { env = process.env }: { env?: NodeJS.ProcessEnv } = {},
) {
  return async function verifySyntheticScope(
    verification: CortexLocalQaSyntheticScopeVerification,
  ): Promise<boolean> {
    const { scope } = verification || {};
    const ownerId = String(scope?.ownerId || '').trim();
    const conversationId = String(scope?.conversationId || '').trim();
    const parentMessageId = String(scope?.parentMessageId || '').trim();
    const caseTokenHash = String(verification?.caseTokenHash || '').trim();
    const ownerScopeHash = String(verification?.ownerScopeHash || '').trim();
    const conversationScopeHash = String(verification?.conversationScopeHash || '').trim();
    const parentScopeHash = String(verification?.parentScopeHash || '').trim();
    const configuredArtifactDigest = String(env[COMPONENT_ARTIFACT_DIGEST_ENV] || '').trim();
    const componentArtifactDigest = String(verification?.componentArtifactDigest || '').trim();
    const armedAtText = typeof verification?.armedAt === 'string' ? verification.armedAt : '';
    const expiresAtText = typeof verification?.expiresAt === 'string' ? verification.expiresAt : '';
    const expiresAt = new Date(expiresAtText || 0);
    if (
      !ownerId ||
      !FIXTURE_CONVERSATION_ID.test(conversationId) ||
      !FIXTURE_PARENT_ID.test(parentMessageId) ||
      !SHA256_HASH.test(caseTokenHash) ||
      !SHA256_HASH.test(ownerScopeHash) ||
      !SHA256_HASH.test(conversationScopeHash) ||
      !SHA256_HASH.test(parentScopeHash) ||
      !SHA256_HASH.test(configuredArtifactDigest) ||
      componentArtifactDigest !== configuredArtifactDigest ||
      !isCanonicalTimestamp(armedAtText) ||
      !isCanonicalTimestamp(expiresAtText) ||
      !Number.isFinite(expiresAt.getTime())
    ) {
      return false;
    }
    try {
      const { User, Conversation, Message } = getFixtureModels();
      if (!User || !Conversation || !Message) return false;
      const fixtureSource = `${FIXTURE_TAG}:${caseTokenHash}`;
      const [owner, conversation, parent] = await Promise.all([
        User.findOne({ _id: ownerId })
          .select({ _id: 1, email: 1, provider: 1, idOnTheSource: 1, expiresAt: 1 })
          .lean(),
        Conversation.findOne({ user: ownerId, conversationId })
          .select({ _id: 1, user: 1, conversationId: 1, tags: 1, expiredAt: 1 })
          .lean(),
        Message.findOne({
          user: ownerId,
          conversationId,
          messageId: parentMessageId,
        })
          .select({
            _id: 1,
            user: 1,
            conversationId: 1,
            messageId: 1,
            isCreatedByUser: 1,
            expiredAt: 1,
            'metadata.viventium.localQaFixture': 1,
          })
          .lean(),
      ]);
      const tags = Array.isArray(conversation?.tags) ? [...conversation.tags].sort() : [];
      const expectedTags = [FIXTURE_TAG, caseTokenHash].sort();
      const marker = parent?.metadata?.viventium?.localQaFixture;
      return Boolean(
        owner &&
        String(owner._id) === ownerId &&
        FIXTURE_OWNER_EMAIL.test(String(owner.email || '')) &&
        owner.provider === FIXTURE_PROVIDER &&
        owner.idOnTheSource === fixtureSource &&
        dateCovers(owner.expiresAt, expiresAt) &&
        conversation &&
        String(conversation.user) === ownerId &&
        conversation.conversationId === conversationId &&
        tags.length === expectedTags.length &&
        tags.every((tag, index) => tag === expectedTags[index]) &&
        dateCovers(conversation.expiredAt, expiresAt) &&
        parent &&
        String(parent.user) === ownerId &&
        parent.conversationId === conversationId &&
        parent.messageId === parentMessageId &&
        parent.isCreatedByUser === false &&
        dateCovers(parent.expiredAt, expiresAt) &&
        exactKeys(marker, FIXTURE_METADATA_KEYS) &&
        marker.schemaVersion === 1 &&
        marker.caseId === FIXTURE_CASE_ID &&
        marker.componentArtifactDigest === componentArtifactDigest &&
        marker.caseTokenHash === caseTokenHash &&
        marker.ownerScopeHash === ownerScopeHash &&
        marker.conversationScopeHash === conversationScopeHash &&
        marker.parentScopeHash === parentScopeHash &&
        dateCovers(marker.expiresAt, expiresAt),
      );
    } catch {
      return false;
    }
  };
}

export function createLocalQaCortexFaultService({
  ControlModel,
  UserModel,
  ConversationModel,
  MessageModel,
  modelProvider,
  fixtureModelProvider,
  env = process.env,
  now,
  randomUUID,
}: LocalQaCortexFaultServiceOptions = {}) {
  let getControlModel = modelProvider || missingModelProvider;
  if (ControlModel) {
    getControlModel = () => ControlModel;
  } else if (typeof modelProvider === 'function') {
    getControlModel = modelProvider;
  }
  let getFixtureModels = fixtureModelProvider || missingModelProvider;
  if (UserModel || ConversationModel || MessageModel) {
    getFixtureModels = () => ({
      User: UserModel,
      Conversation: ConversationModel,
      Message: MessageModel,
    });
  }
  const clock = typeof now === 'function' ? now : () => new Date();
  const verifySyntheticScope = createMongoSyntheticScopeVerifier(getFixtureModels, { env });
  const manager = createCortexLocalQaFaultControlManager({
    store: createMongoFaultControlStore(getControlModel),
    verifySyntheticScope,
    env,
    now: clock,
    ...(typeof randomUUID === 'function' ? { randomUUID } : {}),
  });
  return manager;
}
