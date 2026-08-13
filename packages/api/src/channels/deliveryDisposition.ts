export type DeliveryDispositionAudio = 'skip' | 'eligible';

export type DeliveryDispositionSource =
  | 'model'
  | 'legacy_marker'
  | 'required_missing'
  | 'required_malformed';

export interface DeliveryDisposition {
  version: 1;
  audio: DeliveryDispositionAudio;
  required: boolean;
  valid: boolean;
  source: DeliveryDispositionSource;
}

export type DeliveryDispositionCapture =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'valid'; disposition: DeliveryDisposition };

const contractKeys = ['audio', 'required', 'source', 'valid', 'version'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const recordAt = (value: unknown, key: string): Record<string, unknown> | null => {
  if (!isRecord(value)) {
    return null;
  }
  const nested = value[key];
  return isRecord(nested) ? nested : null;
};

export function validateDeliveryDisposition(value: unknown): DeliveryDisposition | null {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== contractKeys.join(',')) {
    return null;
  }
  if (
    value.version !== 1 ||
    (value.audio !== 'skip' && value.audio !== 'eligible') ||
    value.required !== true ||
    value.valid !== true ||
    value.source !== 'model'
  ) {
    return null;
  }
  return Object.freeze({
    version: 1,
    audio: value.audio,
    required: true,
    valid: true,
    source: 'model',
  });
}

function dispositionCandidate(envelope: unknown): { found: boolean; value?: unknown } {
  const providerFields = recordAt(envelope, 'provider_specific_fields');
  const viventium = recordAt(providerFields, 'viventium');
  if (!viventium || !Object.prototype.hasOwnProperty.call(viventium, 'delivery_disposition')) {
    return { found: false };
  }
  return { found: true, value: viventium.delivery_disposition };
}

export function inspectProviderDeliveryDisposition(value: unknown): DeliveryDispositionCapture {
  const root = isRecord(value) ? value : null;
  const additional = recordAt(root, 'additional_kwargs');
  const raw = recordAt(additional, '__raw_response') ?? recordAt(root, '__raw_response') ?? root;
  const rawChoices = raw?.choices;
  const choices = Array.isArray(rawChoices) ? rawChoices : [];
  const candidates = [dispositionCandidate(additional), dispositionCandidate(root)];

  for (const choice of choices) {
    candidates.push(
      dispositionCandidate(recordAt(choice, 'message')),
      dispositionCandidate(recordAt(choice, 'delta')),
    );
  }

  const present = candidates.filter((candidate) => candidate.found);
  if (present.length === 0) {
    return { status: 'missing' };
  }
  const dispositions = present.map((candidate) => validateDeliveryDisposition(candidate.value));
  if (dispositions.some((candidate) => candidate == null)) {
    return { status: 'malformed' };
  }
  const validDispositions = dispositions.filter(
    (candidate): candidate is DeliveryDisposition => candidate != null,
  );
  const disposition =
    validDispositions.find((candidate) => candidate.audio === 'skip') ??
    validDispositions[validDispositions.length - 1];
  return disposition ? { status: 'valid', disposition } : { status: 'malformed' };
}

export function resolveEffectiveDeliveryDisposition({
  audioEligible,
  legacySkipVoice,
  captured,
}: {
  audioEligible: boolean;
  legacySkipVoice: boolean;
  captured: DeliveryDispositionCapture;
}): DeliveryDisposition | null {
  if (legacySkipVoice) {
    return {
      version: 1,
      audio: 'skip',
      required: audioEligible,
      valid: true,
      source: 'legacy_marker',
    };
  }
  if (!audioEligible) {
    return null;
  }
  if (captured.status === 'valid') {
    return captured.disposition;
  }
  return {
    version: 1,
    audio: 'skip',
    required: true,
    valid: false,
    source: captured.status === 'malformed' ? 'required_malformed' : 'required_missing',
  };
}

export function supportsMessagingDeliveryDisposition(capability: unknown): boolean {
  return (
    isRecord(capability) &&
    capability.messaging_delivery_disposition === true &&
    capability.messaging_delivery_disposition_version === 1
  );
}
