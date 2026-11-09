/* === VIVENTIUM START === One saved Native result and its existing surface delivery owner. === */
const {
  buildCortexInsightDeliveryCandidates,
  buildMainGenerationPresentation,
  mainGenerationPresentation,
  nativeCoordinatorResultEvidence,
  nativeCoordinatorResultEventId,
} = require('@librechat/api');
const isEqual = require('lodash/isEqual');

const failure = (code) => Object.assign(new Error(code), { code });
const intentionalDrop = (row) =>
  row.status === 'dropped' && row.dropReason !== 'delivery_attempts_exhausted';
const surfaceFor = (request) =>
  request.viventiumSurface === 'voice' ? 'web' : request.viventiumSurface || 'web';
const presentationParent = (message) =>
  message.metadata?.viventium?.cortexPresentationParentMessageId || message.parentMessageId;

function nativeResultSource(binding, source, data) {
  if (data.turn_id)
    return {
      kind: 'native_coordinator_turn',
      bindingRef: binding._id,
      nativeConversationId: binding.nativeConversationId,
      turnId: data.turn_id,
      requestId: data.request_id,
      runId: data.run_id,
      resultRevision: data.result_revision,
      resultDigest: data.result_digest,
      sourceTurnId: source.turnId,
      sourceCallSessionId:
        source.requestBody.viventiumCallSessionId ||
        source.requestBody.viventiumVoiceCallSessionId ||
        '',
    };
  return {
    bindingRef: binding._id,
    nativeConversationId: binding.nativeConversationId,
    goalId: data.goal_id,
    runId: data.run_id,
    resultRevision: data.result_revision,
    resultDigest: data.result_digest,
    sourceTurnId: source.turnId,
    sourceCallSessionId:
      source.requestBody.viventiumCallSessionId ||
      source.requestBody.viventiumVoiceCallSessionId ||
      '',
  };
}

function bindNativeResultAuthority(message, binding, source, data) {
  const authority = buildMainGenerationPresentation(
    { nativeCoordinatorResult: nativeResultSource(binding, source, data) },
    message.messageId,
    message.text || '',
  );
  if (!authority) throw failure('coordinator_presentation_authority_invalid');
  const previous = message.metadata?.viventium?.mainGenerationPresentation;
  if (previous && !isEqual(previous, authority))
    throw failure('coordinator_presentation_authority_conflict');
  return {
    ...message,
    metadata: {
      ...message.metadata,
      viventium: { ...message.metadata?.viventium, mainGenerationPresentation: authority },
    },
  };
}

/** Matches retained typed source records; no tool, name or prompt-text inference is used. */
function proveSavedNativeResult({
  tenantId,
  parent,
  rows,
  message,
  binding,
  source,
  goal,
  turn,
  result,
}) {
  const request = source?.requestBody;
  const parentId = request?.messageId || request?.parentMessageId;
  const subject = turn || goal;
  const selectedIdentity = turn
    ? result?.turn_id === turn.turn_id &&
      result?.request_id === turn.request_id &&
      result?.publisher?.request_id === turn.request_id &&
      result?.publisher?.message_id === turn.turn_id &&
      result?.publisher?.stream_id === turn.turn_id
    : Boolean(goal) && result?.goal_id === goal.goal_id;

  if (
    !binding ||
    binding.kind !== 'native_coordinator_binding' ||
    binding.active !== true ||
    binding.tenantId !== tenantId ||
    binding.ownerId !== parent.ownerId ||
    binding.conversationId !== parent.conversationId ||
    !source ||
    source.kind !== 'native_coordinator_source' ||
    source.bindingRef !== binding._id ||
    request.conversationId !== binding.conversationId ||
    parentId !== parent.parentMessageId ||
    !subject ||
    subject.source_turn_id !== source.turnId ||
    !result ||
    !selectedIdentity ||
    result.run_id !== subject.run_id ||
    result.result_revision !== subject.result_revision ||
    !['completed', 'failed'].includes(result.state) ||
    !Number.isSafeInteger(result.result_revision) ||
    result.result_revision < 1 ||
    result.publisher?.owner_id !== parent.ownerId ||
    result.publisher?.conversation_id !== binding.nativeConversationId ||
    result.publisher?.agent_id !== 'coordinator' ||
    result.publisher?.run_id !== subject.run_id ||
    ![
      result.publisher?.request_id,
      result.publisher?.message_id,
      result.publisher?.stream_id,
    ].every((value) => typeof value === 'string' && value) ||
    rows.length !== 1 ||
    rows[0].userId !== parent.ownerId ||
    rows[0].conversationId !== parent.conversationId ||
    rows[0].parentMessageId !== parent.parentMessageId ||
    rows[0].surface !== surfaceFor(request)
  )
    return null;
  const data = {
    request_ref: binding._id,
    conversation_id: binding.nativeConversationId,
    ...(turn ? { turn_id: turn.turn_id, request_id: turn.request_id } : { goal_id: goal.goal_id }),
    run_id: subject.run_id,
    result_revision: result.result_revision,
    result_digest: `sha256:${result.sha256}`,
  };
  const evidence =
    result.total_chars === 0
      ? nativeCoordinatorResultEvidence({
          text: '',
          state: result.state,
          failureClass: result.failure_class,
          runId: subject.run_id,
          resultRevision: result.result_revision,
          resultDigest: data.result_digest,
        })
      : rows[0].insight;
  const candidate = buildCortexInsightDeliveryCandidates({
    ownerId: parent.ownerId,
    conversationId: parent.conversationId,
    parentMessageId: parent.parentMessageId,
    surface: surfaceFor(request),
    insights: [
      {
        cortexId: nativeCoordinatorResultEventId(data),
        status: 'completed',
        insight: evidence,
      },
    ],
  })[0];
  const expectedHash = result.total_chars === 0 ? candidate?.insightHash : result.sha256;
  if (
    !candidate ||
    candidate.deliveryId !== rows[0].deliveryId ||
    rows[0].insightHash !== expectedHash ||
    rows[0].graphResultHash !== expectedHash
  )
    return null;
  const eligible =
    subject.intent_state === 'accepted' &&
    subject.restore_hold === false &&
    subject.state === result.state &&
    (!turn ||
      (result.state === 'completed' &&
        result.superseded === false &&
        result.presentation_eligible === true));
  if (!message) {
    // An accepted result owns its unpublished author turn too. A deleted saved reply is not
    // unpublished work and must never be recreated by recovery.
    const unpublished = rows[0].persistenceStatus === 'pending' && !rows[0].persistedMessageId;
    return {
      binding,
      source,
      goal,
      turn,
      result,
      data,
      rows,
      unpublished,
      eligible: eligible && unpublished,
    };
  }
  if (
    message.user !== parent.ownerId ||
    message.conversationId !== parent.conversationId ||
    presentationParent(message) !== parent.parentMessageId ||
    message.isCreatedByUser !== false ||
    message.error ||
    message.unfinished ||
    message.deletedAt ||
    (rows[0].persistedMessageId && rows[0].persistedMessageId !== message.messageId) ||
    !['pending', 'persisted'].includes(rows[0].persistenceStatus) ||
    message.metadata?.viventium?.cortexInsightDeliveryIds?.length !== 1 ||
    message.metadata.viventium.cortexInsightDeliveryIds[0] !== rows[0].deliveryId
  )
    return { binding, source, goal, turn, result, data, rows, message, eligible: false };
  const needsPersistence = rows[0].persistenceStatus === 'pending' && !rows[0].persistedMessageId;
  if (!needsPersistence && rows[0].persistedMessageId !== message.messageId)
    return { binding, source, goal, turn, result, data, rows, message, eligible: false };
  const bound = bindNativeResultAuthority(message, binding, source, data);
  const previous = message.metadata?.viventium?.mainGenerationPresentation;
  if (previous && !isEqual(previous, bound.metadata.viventium.mainGenerationPresentation))
    throw failure('coordinator_presentation_authority_conflict');
  return {
    binding,
    source,
    goal,
    turn,
    result,
    data,
    message: bound,
    previousAuthority: previous,
    rows,
    eligible,
    needsPersistence,
  };
}

/** Historical publication metadata proves ownership only, never permission to publish again. */
function proveNativePublicationOwnership({ tenantId, parent, rows, binding, source, publication }) {
  const request = source?.requestBody;
  const data = publication?.data;
  if (
    binding?.kind !== 'native_coordinator_binding' ||
    binding.active !== true ||
    binding.tenantId !== tenantId ||
    binding.ownerId !== parent.ownerId ||
    binding.conversationId !== parent.conversationId ||
    source?.kind !== 'native_coordinator_source' ||
    source.bindingRef !== binding._id ||
    request?.conversationId !== parent.conversationId ||
    (request.messageId || request.parentMessageId) !== parent.parentMessageId ||
    !['coordinator.result_ready', 'coordinator.turn_result_ready'].includes(publication?.type) ||
    typeof publication.event_id !== 'string' ||
    !publication.event_id ||
    publication.source_turn_id !== source.turnId ||
    data?.request_ref !== binding._id ||
    data.conversation_id !== binding.nativeConversationId ||
    (publication.type === 'coordinator.result_ready'
      ? typeof data.goal_id !== 'string' || !data.goal_id || data.turn_id !== undefined
      : typeof data.turn_id !== 'string' ||
        !data.turn_id ||
        typeof data.request_id !== 'string' ||
        !data.request_id ||
        data.goal_id !== undefined) ||
    typeof data.run_id !== 'string' ||
    !data.run_id ||
    !Number.isSafeInteger(data.result_revision) ||
    data.result_revision < 1 ||
    typeof data.result_digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(data.result_digest) ||
    rows.length !== 1 ||
    rows[0].userId !== parent.ownerId ||
    rows[0].conversationId !== parent.conversationId ||
    rows[0].parentMessageId !== parent.parentMessageId ||
    rows[0].surface !== surfaceFor(request)
  )
    return null;
  const eventId = nativeCoordinatorResultEventId(data);
  const candidate = buildCortexInsightDeliveryCandidates({
    ...parent,
    surface: surfaceFor(request),
    insights: [{ cortexId: eventId, status: 'completed', insight: rows[0].insight }],
  })[0];
  if (
    !candidate ||
    candidate.deliveryId !== rows[0].deliveryId ||
    candidate.insightHash !== rows[0].insightHash ||
    candidate.graphResultHash !== rows[0].graphResultHash ||
    (rows[0].publicationId && rows[0].publicationId !== eventId)
  )
    return null;
  return { binding, source, data, rows, eligible: false, retainedPublication: true };
}

function createNativeCoordinatorPresentationService(deps) {
  async function resolve(parent) {
    const rows = await deps.readRows(parent);
    if (!rows.length || rows.some((row) => row.conversationId !== parent.conversationId))
      return null;
    const ids = [...new Set(rows.map((row) => row.persistedMessageId).filter(Boolean))];
    if (ids.length > 1) return null;
    const matches = ids.length
      ? []
      : await deps.findMessages({ ...parent, deliveryIds: rows.map((row) => row.deliveryId) });
    const message = ids.length
      ? await deps.readMessage({ ...parent, messageId: ids[0] })
      : matches.length === 1
        ? matches[0]
        : null;
    const retained = message?.metadata?.viventium?.mainGenerationPresentation;
    let sources;
    if (retained) {
      const parsed = mainGenerationPresentation({
        event: 'main.followup',
        callbackMessageId: message.messageId,
        mainGenerationPresentation: retained,
      });
      if (retained.version === 1) return null;
      if (parsed?.version !== 2) throw failure('coordinator_presentation_authority_invalid');
      sources = await deps.readSources(parent, parsed.nativeCoordinatorResult);
      if (!sources.length) throw failure('coordinator_presentation_authority_unavailable');
    } else sources = await deps.readSources(parent);
    let proved = null;
    const snapshots = new Map();
    for (const { binding, source } of sources) {
      if (!snapshots.has(binding.nativeConversationId))
        snapshots.set(binding.nativeConversationId, await deps.readSnapshot(binding));
      const snapshot = snapshots.get(binding.nativeConversationId);
      const retainedSource = retained?.nativeCoordinatorResult;
      if (retainedSource?.kind === 'native_coordinator_turn') {
        const result = await deps.readTurnResult(binding, {
          turn_id: retainedSource.turnId,
          request_id: retainedSource.requestId,
          run_id: retainedSource.runId,
        });
        const value = proveSavedNativeResult({
          tenantId: deps.tenantId(),
          parent,
          rows,
          message,
          binding,
          source,
          turn: result,
          result,
        });
        if (value) {
          if (matches.length > 1)
            Object.assign(value, { eligible: false, unpublished: false, ambiguous: true });
          if (proved) throw failure('coordinator_presentation_authority_conflict');
          proved = value;
        }
        continue;
      }
      for (const goal of snapshot.goals || []) {
        if (goal.source_turn_id !== source.turnId || !goal.run_id) continue;
        if (
          retained &&
          (goal.goal_id !== retained.nativeCoordinatorResult.goalId ||
            goal.run_id !== retained.nativeCoordinatorResult.runId)
        )
          continue;
        const result = await deps.readResult(binding, goal);
        const value = proveSavedNativeResult({
          tenantId: deps.tenantId(),
          parent,
          rows,
          message,
          binding,
          source,
          goal,
          result,
        });
        if (!value) continue;
        if (matches.length > 1)
          Object.assign(value, { eligible: false, unpublished: false, ambiguous: true });
        if (proved) throw failure('coordinator_presentation_authority_conflict');
        proved = value;
      }
    }
    // A saved typed authority remains owned when Stop/hold/supersession blocks current delivery.
    if (!proved && retained?.version === 2 && sources.length)
      return { eligible: false, message, rows };
    if (!proved) {
      const publications = new Map();
      for (const { binding, source } of sources) {
        if (!publications.has(binding.nativeConversationId))
          publications.set(binding.nativeConversationId, await deps.readPublications(binding));
        for (const publication of publications.get(binding.nativeConversationId)) {
          const value = proveNativePublicationOwnership({
            tenantId: deps.tenantId(),
            parent,
            rows,
            binding,
            source,
            publication,
          });
          if (!value) continue;
          let current = value;
          if (publication.type === 'coordinator.turn_result_ready') {
            const result = await deps.readTurnResult(binding, publication.data);
            current =
              proveSavedNativeResult({
                tenantId: deps.tenantId(),
                parent,
                rows,
                message,
                binding,
                source,
                turn: result,
                result,
              }) || value;
            if (matches.length > 1)
              Object.assign(current, { eligible: false, unpublished: false, ambiguous: true });
          }
          if (proved) throw failure('coordinator_presentation_authority_conflict');
          proved = current;
        }
      }
    }
    return proved;
  }

  async function recover(parent) {
    const owned = await resolve(parent);
    if (!owned) return false;
    if (!owned.eligible || owned.rows.some(intentionalDrop)) return true;
    if (owned.unpublished) {
      if (owned.rows.some((row) => row.status === 'dropped')) {
        await deps.ledger.resumeTransportFailure({
          ...parent,
          deliveryIds: owned.rows.map((row) => row.deliveryId),
          persistenceStatus: 'pending',
          persistedMessageId: '',
          messageRevision: owned.rows[0].presentationRevision || owned.rows[0].messageRevision || 1,
        });
      }
      await deps.publishUnpublished({ binding: owned.binding, data: owned.data });
      return true;
    }
    if (owned.rows.every((row) => row.status === 'sent')) return true;
    if (owned.rows.some((row) => row.status === 'dropped')) {
      await deps.ledger.resumeTransportFailure({
        ...parent,
        deliveryIds: owned.rows.map((row) => row.deliveryId),
        ...(owned.needsPersistence
          ? { persistenceStatus: 'pending', persistedMessageId: '' }
          : { persistedMessageId: owned.message.messageId }),
        messageRevision: owned.message.metadata.viventium.messageRevision || 1,
      });
    }
    const batch = await deps.ledger.claimPendingByParent({
      ...parent,
      deliveryIds: owned.rows.map((row) => row.deliveryId),
    });
    let active = batch.claimed || [];
    if (
      !active.length &&
      owned.needsPersistence &&
      owned.rows.every(
        (row) =>
          row.status === 'claimed' &&
          row.claimToken &&
          row.claimToken === owned.message.metadata.viventium.cortexPresentationClaimToken &&
          row.claimGeneration === owned.message.metadata.viventium.cortexPresentationGeneration,
      )
    )
      active = owned.rows;
    if (!active.length) {
      try {
        const fence = await deps.ledger.fencePresentationByParent({
          ...parent,
          surface: owned.rows[0].requiredSurfaces?.[0] || 'web',
          persistedMessageId: owned.message.messageId,
          messageRevision: owned.message.metadata.viventium.messageRevision || 1,
          expectedDeliveryIds: owned.rows.map((row) => row.deliveryId),
        });
        active = fence.claims;
      } catch (error) {
        if (error?.code === 'cortex_insight_delivery_settlement_conflict') return true;
        throw error;
      }
    }
    if (
      !active.length ||
      active.length !== owned.rows.length ||
      active.some((row) => !owned.rows.some((expected) => expected.deliveryId === row.deliveryId))
    )
      return true;
    const claims = active.map(({ deliveryId, claimToken, claimGeneration }) => ({
      deliveryId,
      claimToken,
      claimGeneration,
    }));
    if (new Set(claims.map((claim) => claim.claimGeneration)).size !== 1)
      throw failure('coordinator_presentation_claim_conflict');
    const message = await deps.bindMessage(owned.message, {
      ...parent,
      claimGeneration: claims[0].claimGeneration,
      claimToken: claims[0].claimToken,
      previousAuthority: owned.previousAuthority,
    });
    await deps.ledger.markPersisted({
      ownerId: parent.ownerId,
      claims,
      persistedMessageId: message.messageId,
      messageRevision: message.metadata.viventium.messageRevision || 1,
    });
    const receipt = await deps.enqueue({ ...owned, message });
    if (
      Number(receipt?.unresolved || 0) > 0 ||
      (Number(receipt?.configured || 0) > 0 && !Number(receipt?.enqueued || 0))
    )
      throw failure('coordinator_delivery_unconfirmed');
    if (receipt?.linkedWebCommitted === true && !Number(receipt.configured || 0))
      await settleRows(parent, message, 'web', `message:${message.messageId}`);
    return true;
  }

  async function settleRows(parent, message, deliveredSurface, presentationRef) {
    parent.parentMessageId = message.metadata.viventium.cortexPresentationParentMessageId;
    const ids = message.metadata.viventium.cortexInsightDeliveryIds;
    parent.deliveryIds = ids;
    const rows = await deps.readRows(parent);
    if (
      !Array.isArray(ids) ||
      rows.length !== ids.length ||
      rows.some(
        (row) =>
          !ids.includes(row.deliveryId) ||
          row.persistedMessageId !== message.messageId ||
          row.userId !== parent.ownerId ||
          row.parentMessageId !== parent.parentMessageId ||
          row.conversationId !== parent.conversationId ||
          intentionalDrop(row),
      )
    )
      return false;
    if (rows.every((row) => row.status === 'sent')) return true;
    // The accepted channel receipt is a fact; this projection cannot send or start cognition.
    const required = new Set(rows.flatMap((row) => row.requiredSurfaces || []));
    const alreadyPresented = new Set(rows.flatMap((row) => row.presentedSurfaces || []));
    for (const surface of new Set(['web', deliveredSurface])) {
      if (!required.has(surface) || alreadyPresented.has(surface)) continue;
      const fence = await deps.ledger.fencePresentationByParent({
        ...parent,
        surface,
        persistedMessageId: message.messageId,
        messageRevision: message.metadata.viventium.messageRevision || 1,
        expectedDeliveryIds: ids,
        expectedGeneration: message.metadata.viventium.cortexPresentationGeneration,
      });
      await deps.ledger.markPresentationByParent({
        ...parent,
        surface,
        persistedMessageId: message.messageId,
        messageRevision: message.metadata.viventium.messageRevision || 1,
        presentationGeneration: fence.generation,
        presentationClaimToken: fence.claimToken,
        expectedPresentationLeaseToken: fence.presentationLeaseToken,
        expectedDeliveryIds: ids,
        expectedDeliveryReceipts: fence.deliveryReceipts,
        presentationRef: surface === 'web' ? `message:${message.messageId}` : presentationRef,
      });
    }
    return true;
  }

  async function settle(candidate) {
    const authority = mainGenerationPresentation(candidate);
    if (authority?.version !== 2 || candidate.status !== 'sent') return false;
    const delivery = await deps.readDelivery(candidate);
    if (
      !delivery ||
      delivery.status !== 'sent' ||
      !delivery.sentAt ||
      delivery.originRef !== authority.nativeCoordinatorResult.bindingRef ||
      (delivery.surface === 'telegram' &&
        !delivery.telegramSentMessageIds?.length &&
        !delivery.telegramMessageId) ||
      !isEqual(mainGenerationPresentation(delivery), authority)
    )
      return false;
    const parent = { ownerId: delivery.userId, conversationId: delivery.conversationId };
    const message = await deps.readMessage({ ...parent, messageId: delivery.callbackMessageId });
    if (
      !message ||
      !isEqual(message.metadata?.viventium?.mainGenerationPresentation, authority) ||
      !isEqual(
        buildMainGenerationPresentation(
          { nativeCoordinatorResult: authority.nativeCoordinatorResult },
          message.messageId,
          message.text || '',
        ),
        authority,
      ) ||
      message.text?.trim() !== delivery.text?.trim()
    )
      return false;
    return settleRows(parent, message, delivery.surface, `delivery:${delivery.deliveryId}`);
  }

  async function settleLinkedWeb(parent) {
    const owned = await resolve(parent);
    if (!owned?.eligible || owned.rows.some(intentionalDrop)) return false;
    return settleRows(parent, owned.message, 'web', `message:${owned.message.messageId}`);
  }
  return { resolve, recover, settle, settleLinkedWeb };
}

module.exports = {
  nativeResultSource,
  presentationParent,
  bindNativeResultAuthority,
  proveSavedNativeResult,
  proveNativePublicationOwnership,
  createNativeCoordinatorPresentationService,
};
/* === VIVENTIUM END === */
