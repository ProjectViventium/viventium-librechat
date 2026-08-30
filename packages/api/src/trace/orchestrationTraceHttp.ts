/* === VIVENTIUM START ===
 * Feature: Authorized unified orchestration-trace HTTP contract.
 * Purpose: Keep owner scoping, validation, projection, and safe diagnostics in typed package code.
 * === VIVENTIUM END === */

import {
  OrchestrationTraceAccessError,
  buildUnifiedOrchestrationTrace,
} from './orchestrationTrace';
import {
  OrchestrationTraceValidationError,
  type OrchestrationTraceLedgerPage,
} from './orchestrationTraceLedger';
import { safeErrorLogFields } from '../logging/safeError';

type ValueRecord = Record<string, unknown>;
type UnifiedTraceInput = Parameters<typeof buildUnifiedOrchestrationTrace>[0];
type TraceBinding = NonNullable<UnifiedTraceInput['binding']>;
type TraceExternalWork = NonNullable<UnifiedTraceInput['externalWork']>;
type TraceDetail = NonNullable<UnifiedTraceInput['glassHiveDetail']>;
type TracePromptLayers = NonNullable<UnifiedTraceInput['promptLayers']>;

interface HttpRequest {
  params?: ValueRecord;
  query?: ValueRecord;
  user?: { id?: unknown };
}

interface HttpResponse {
  json(body: unknown): unknown;
  set(field: string, value: string): unknown;
  status(statusCode: number): HttpResponse;
}

type Next = () => unknown;

interface CollectionPort<T> {
  findOne(filter: ValueRecord, options: ValueRecord): Promise<T | null>;
}

interface DetailRead {
  detail: TraceDetail | null;
  status: 'available' | 'missing' | 'unavailable';
}

export interface OrchestrationTraceHttpDependencies {
  collection<T>(name: string): CollectionPort<T>;
  logger: {
    error(message: string, details?: object): unknown;
    warn(message: string, details?: object): unknown;
  };
  requestAccountApi(input: ValueRecord): Promise<TraceDetail>;
  readOrchestrationTraceEvents(input: {
    ownerId: string;
    originRef: string;
    afterSequence: number;
    limit: number;
  }): Promise<OrchestrationTraceLedgerPage>;
  recordGlassHiveWorkDetailTrace(input: ValueRecord): Promise<{
    accepted: boolean;
    errors: string[];
  }>;
  promptLayerIntegritySnapshot(): TracePromptLayers;
}

const BINDING_COLLECTION = 'viventium_glasshive_callback_bindings';
const EXTERNAL_WORK_COLLECTION = 'viventium_external_work';
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{7,191}$/;

const bindingProjection = Object.freeze({
  _id: 0,
  ownerId: 1,
  originRef: 1,
  workRef: 1,
  runId: 1,
  launchState: 1,
  createdAt: 1,
  updatedAt: 1,
});

const externalWorkProjection = Object.freeze({
  _id: 0,
  ownerId: 1,
  originRef: 1,
  workRef: 1,
  runId: 1,
  launchState: 1,
  externalState: 1,
  deliveryState: 1,
  terminalAt: 1,
  adjudicatedAt: 1,
  deliveryUpdatedAt: 1,
});

function notFound(res: HttpResponse): unknown {
  return res.status(404).json({
    error: { code: 'ORCHESTRATION_TRACE_NOT_FOUND', message: 'Trace not found.' },
  });
}

export function createOrchestrationTraceHttpHandlers(
  dependencies: OrchestrationTraceHttpDependencies,
) {
  async function readCoreTraceFacts({
    ownerId,
    originRef,
  }: {
    ownerId: string;
    originRef: string;
  }): Promise<{ binding: TraceBinding; externalWork: TraceExternalWork | null } | null> {
    const [binding, externalWork] = await Promise.all([
      dependencies
        .collection<TraceBinding>(BINDING_COLLECTION)
        .findOne({ _id: originRef, ownerId }, { projection: bindingProjection }),
      dependencies
        .collection<TraceExternalWork>(EXTERNAL_WORK_COLLECTION)
        .findOne({ _id: originRef, ownerId }, { projection: externalWorkProjection }),
    ]);
    return binding ? { binding, externalWork } : null;
  }

  async function readGlassHiveDetail({
    ownerId,
    workRef,
  }: {
    ownerId: string;
    workRef: string;
  }): Promise<DetailRead> {
    if (!OPAQUE_REF.test(workRef)) return { detail: null, status: 'missing' };
    try {
      return {
        detail: await dependencies.requestAccountApi({
          ownerId,
          path: `/v1/work/${encodeURIComponent(workRef)}`,
          timeoutMs: 3000,
        }),
        status: 'available',
      };
    } catch (error) {
      dependencies.logger.warn(
        '[VIVENTIUM][orchestration-trace] GlassHive detail unavailable',
        safeErrorLogFields(error, 'glasshive_detail_unavailable'),
      );
      return { detail: null, status: 'unavailable' };
    }
  }

  function noStore(_req: HttpRequest, res: HttpResponse, next: Next): unknown {
    res.set('Cache-Control', 'no-store, private');
    res.set('Pragma', 'no-cache');
    return next();
  }

  async function getTrace(req: HttpRequest, res: HttpResponse): Promise<unknown> {
    const ownerId = String(req.user?.id || '').trim();
    const originRef = String(req.params?.originRef || '').trim();
    const afterSequence = Number(req.query?.after ?? 0);
    const limit = Number(req.query?.limit ?? 50);
    if (
      !ownerId ||
      !OPAQUE_REF.test(originRef) ||
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      return res.status(400).json({
        error: { code: 'INVALID_ORCHESTRATION_TRACE_REF', message: 'The trace ref is invalid.' },
      });
    }

    try {
      const core = await readCoreTraceFacts({ ownerId, originRef });
      if (!core) {
        const ledgerPage = await dependencies.readOrchestrationTraceEvents({
          ownerId,
          originRef,
          afterSequence,
          limit,
        });
        if (ledgerPage.events.length === 0) return notFound(res);
        return res.json(
          buildUnifiedOrchestrationTrace({
            ownerId,
            originRef,
            binding: null,
            ledgerPage,
            glassHiveReadStatus: 'missing',
          }),
        );
      }

      const workRef = String(core.binding.workRef || core.externalWork?.workRef || '').trim();
      const runRef = String(core.externalWork?.runId || '').trim();
      const glassHive = await readGlassHiveDetail({ ownerId, workRef });
      if (glassHive.detail?.state === 'completed' && workRef && runRef) {
        const ingestion = await dependencies.recordGlassHiveWorkDetailTrace({
          ownerId,
          originRef,
          workRef,
          runRef,
          detail: glassHive.detail,
        });
        if (!ingestion.accepted) {
          dependencies.logger.warn('[VIVENTIUM][orchestration-trace] GlassHive detail rejected', {
            codes: ingestion.errors.slice(0, 16),
          });
        }
      }
      const ledgerPage = await dependencies.readOrchestrationTraceEvents({
        ownerId,
        originRef,
        afterSequence,
        limit,
      });
      return res.json(
        buildUnifiedOrchestrationTrace({
          ownerId,
          originRef,
          binding: core.binding,
          externalWork: core.externalWork,
          promptLayers: dependencies.promptLayerIntegritySnapshot(),
          glassHiveDetail: glassHive.detail,
          glassHiveReadStatus: glassHive.status,
          ledgerPage,
        }),
      );
    } catch (error) {
      if (error instanceof OrchestrationTraceAccessError) return notFound(res);
      if (error instanceof OrchestrationTraceValidationError) {
        return res.status(400).json({
          error: {
            code: 'INVALID_ORCHESTRATION_TRACE_PAGE',
            message: 'The trace page is invalid.',
          },
        });
      }
      dependencies.logger.error(
        '[VIVENTIUM][orchestration-trace] Trace read failed',
        safeErrorLogFields(error, 'trace_read_failed'),
      );
      return res.status(500).json({
        error: { code: 'ORCHESTRATION_TRACE_READ_FAILED', message: 'Unable to read trace.' },
      });
    }
  }

  return { noStore, getTrace };
}
