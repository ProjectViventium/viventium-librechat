/* === VIVENTIUM START ===
 * Feature: Eager Active work tools for Viventium Main.
 * Purpose: One provider-independent list/action facade backed by owner-scoped GlassHive truth.
 * === VIVENTIUM END === */

const { tool } = require('@langchain/core/tools');
const { z } = require('zod');
const {
  getActiveWorkPage,
} = require('~/server/services/viventium/GlassHiveAccountService');
const {
  executeGlassHiveWorkAction,
} = require('~/server/services/viventium/GlassHiveWorkActionService');
const {
  ACTIVE_WORK_ACTION_DESCRIPTION,
  ACTIVE_WORK_ACTION_SEMANTICS,
  ACTIVE_WORK_LIST_DESCRIPTION,
  mainOrchestrationInvocationIdentity,
} = require('~/server/services/viventium/GlassHiveConversationOrchestration');

const workRefSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/);
const listSchema = z
  .object({
    cursor: z.string().regex(/^[A-Za-z0-9._~:@+-]{1,2048}$/).optional(),
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

function createActiveWorkTools({ userId, req }) {
  const ownerId = String(userId || '').trim();
  if (!ownerId) {
    throw new Error('active_work_owner_required');
  }

  const list = tool(
    async (input) =>
      JSON.stringify(
        await getActiveWorkPage({
          ownerId,
          cursor: input.cursor || '',
          limit: input.limit || 50,
        }),
      ),
    {
      name: 'active_work_list',
      description: ACTIVE_WORK_LIST_DESCRIPTION,
      schema: listSchema,
    },
  );

  const action = tool(
    async (input, runnableConfig) => {
      const requestBody =
        runnableConfig?.configurable?.requestBody || req?._viventiumMcpRequestBody || {};
      const operationId = mainOrchestrationInvocationIdentity({
        userId: ownerId,
        requestBody,
        toolName: 'active_work_action',
        args: input,
        // This occurrence id is provider/runtime metadata carried by Core, never model input.
        // It keeps separate identical actions distinct while the same reconstructed call replays.
        trustedCallIdentity: runnableConfig?.toolCall?.id,
      });
      if (!operationId) {
        throw new Error('active_work_operation_identity_unavailable');
      }
      return JSON.stringify(
        await executeGlassHiveWorkAction({
          ownerId,
          workRef: input.workRef,
          action: input.action,
          operationId,
          ...(input.instruction ? { instruction: input.instruction } : {}),
        }),
      );
    },
    {
      name: 'active_work_action',
      description: ACTIVE_WORK_ACTION_DESCRIPTION,
      schema: controlSchema,
    },
  );

  return { list, action };
}

module.exports = { createActiveWorkTools };
