/* === VIVENTIUM START ===
 * Feature: Eager Active work tools for Viventium Main.
 * Purpose: Keep validation and trusted invocation identity in the typed package while /api only
 * wires owner-scoped GlassHive adapters.
 * === VIVENTIUM END === */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { TOOL_EFFECT_CLASSES, toolEffectMetadata } from '../tools/toolEffectMetadata';
import {
  ACTIVE_WORK_ACTION_DESCRIPTION,
  ACTIVE_WORK_ACTION_SEMANTICS,
  ACTIVE_WORK_LIST_DESCRIPTION,
  mainOrchestrationInvocationIdentity,
} from './conversationOrchestration';

type UnknownRecord = Record<string, unknown>;

export interface ActiveWorkToolsDependencies {
  getActiveWorkPage(input: { ownerId: string; cursor: string; limit: number }): Promise<unknown>;
  executeGlassHiveWorkAction(input: UnknownRecord): Promise<unknown>;
}

export interface ActiveWorkToolsOptions {
  userId?: unknown;
  req?: unknown;
}

const workRefSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/);
const listSchema = z
  .object({
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9._~:@+-]{1,2048}$/)
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
const controlSchema = z
  .object({
    workRef: workRefSchema.describe('Opaque workRef returned by active_work_list'),
    action: z
      .enum(['queue', 'message', 'steer', 'pause', 'resume', 'stop', 'retry', 'dismiss'])
      .describe(ACTIVE_WORK_ACTION_SEMANTICS),
    instruction: z.string().trim().min(1).max(8000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (['queue', 'message', 'steer'].includes(value.action) && !value.instruction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instruction'],
        message: `${value.action} requires an instruction`,
      });
    }
  });

function recordFrom(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function requestBodyFrom(options: ActiveWorkToolsOptions, runnableConfig: unknown): UnknownRecord {
  const config = recordFrom(runnableConfig);
  const configuredRequest = recordFrom(config.configurable).requestBody;
  if (typeof configuredRequest === 'object' && configuredRequest !== null) {
    return recordFrom(configuredRequest);
  }
  return recordFrom(recordFrom(options.req)._viventiumMcpRequestBody);
}

/** Build Main's owner-scoped active-work tools from trusted server adapters. */
export function createActiveWorkTools(
  options: ActiveWorkToolsOptions,
  deps: ActiveWorkToolsDependencies,
) {
  const ownerId = String(options.userId || '').trim();
  if (!ownerId) {
    throw new Error('active_work_owner_required');
  }

  const list = tool(
    async (input) =>
      JSON.stringify(
        await deps.getActiveWorkPage({
          ownerId,
          cursor: input.cursor || '',
          limit: input.limit || 50,
        }),
      ),
    {
      name: 'active_work_list',
      description: ACTIVE_WORK_LIST_DESCRIPTION,
      schema: listSchema,
      metadata: toolEffectMetadata(TOOL_EFFECT_CLASSES.readOnly),
    },
  );

  const action = tool(
    async (input, runnableConfig) => {
      const requestBody = requestBodyFrom(options, runnableConfig);
      const operationId = mainOrchestrationInvocationIdentity({
        userId: ownerId,
        requestBody,
        toolName: 'active_work_action',
        args: input,
        trustedCallIdentity: recordFrom(recordFrom(runnableConfig).toolCall).id,
      });
      if (!operationId) {
        throw new Error('active_work_operation_identity_unavailable');
      }
      return JSON.stringify(
        await deps.executeGlassHiveWorkAction({
          ownerId,
          workRef: input.workRef,
          action: input.action,
          operationId,
          durableEffectContext: {
            streamId: requestBody.viventiumStreamId,
            sourceEventId: requestBody.viventiumAuthoringSourceEventId,
            sourceRevision: requestBody.viventiumAuthoringSourceRevision,
            sourceSurface: requestBody.viventiumAuthoringSurface,
            responseMessageId: requestBody.messageId || requestBody.responseMessageId,
          },
          ...(input.instruction ? { instruction: input.instruction } : {}),
        }),
      );
    },
    {
      name: 'active_work_action',
      description: ACTIVE_WORK_ACTION_DESCRIPTION,
      schema: controlSchema,
      metadata: toolEffectMetadata(TOOL_EFFECT_CLASSES.externalMutation),
    },
  );

  return { list, action };
}

/* === VIVENTIUM END === */
