import type { ViventiumVoiceRouteState } from '@librechat/data-schemas';

/* === VIVENTIUM START === Current Call facts use the admitted route, not workspace defaults. === */
export interface GatewayVoiceRuntimeContext {
  version: 1;
  callSessionId: string;
  readyRoute: ViventiumVoiceRouteState;
  configuredTtsFallback?: string | null;
  turnHandling?: {
    turnDetection?: string;
    minEndpointingDelayS?: number;
    maxEndpointingDelayS?: number;
    minInterruptionDurationS?: number;
    minInterruptionWords?: number;
  };
}

interface CurrentCallRequest {
  user?: { id?: string };
  body?: { voiceMode?: boolean };
  viventiumCallSession?: {
    callSessionId: string;
    userId: string;
    agentId: string;
    mode?: string;
    requestedVoiceRoute?: ViventiumVoiceRouteState | null;
  };
}

const admittedCallContexts = new WeakMap<CurrentCallRequest, string>();

function routeId(value: string | null | undefined, maximum = 160) {
  return typeof value === 'string' && value.length <= maximum &&
    /^[a-z0-9][a-z0-9._:/-]*$/i.test(value) ? value : null;
}

function routeState(value?: ViventiumVoiceRouteState | null): ViventiumVoiceRouteState {
  return {
    stt: { provider: routeId(value?.stt?.provider), variant: routeId(value?.stt?.variant) },
    tts: { provider: routeId(value?.tts?.provider), variant: routeId(value?.tts?.variant) },
  };
}

function duration(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 120
    ? value : null;
}

export function bindCurrentCallContext(
  request: CurrentCallRequest,
  gateway?: GatewayVoiceRuntimeContext | null,
): boolean {
  if (admittedCallContexts.has(request)) return true;
  const session = request.viventiumCallSession;
  if (!session || request.body?.voiceMode !== true || !request.user?.id ||
      session.userId !== request.user.id || !routeId(session.callSessionId) ||
      !routeId(session.agentId)) return false;
  const selected = routeState(session.requestedVoiceRoute);
  const ready = gateway?.version === 1 && gateway.callSessionId === session.callSessionId
    ? gateway : null;
  const readyRoute = ready ? routeState(ready.readyRoute) : null;
  const turn = ready?.turnHandling;
  const facts = {
    version: 1,
    callSessionId: session.callSessionId,
    agentId: session.agentId,
    mode: ['call', 'wing', 'listen_only'].includes(session.mode || '') ? session.mode : 'call',
    requestedRoute: selected,
    gatewayReadyRoute: readyRoute,
    configuredTtsFallback: ready ? routeId(ready.configuredTtsFallback) : null,
    turnHandling: turn ? {
      turnDetection: routeId(turn.turnDetection),
      minEndpointingDelayS: duration(turn.minEndpointingDelayS),
      maxEndpointingDelayS: duration(turn.maxEndpointingDelayS),
      minInterruptionDurationS: duration(turn.minInterruptionDurationS),
      minInterruptionWords: Number.isInteger(turn.minInterruptionWords) &&
        Number(turn.minInterruptionWords) >= 0 && Number(turn.minInterruptionWords) <= 100
        ? turn.minInterruptionWords : null,
    } : null,
    actualPlaybackRoute: null,
  };
  admittedCallContexts.set(request,
    `<viventium_current_call_v1>${JSON.stringify(facts)}</viventium_current_call_v1>`);
  return true;
}

export function getCurrentCallContext(request: CurrentCallRequest): string {
  return admittedCallContexts.get(request) || '';
}
/* === VIVENTIUM END === */
