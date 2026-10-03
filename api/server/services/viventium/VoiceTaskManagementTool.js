/* === VIVENTIUM START ===
 * Feature: manage_active_tasks structured voice tool
 * Purpose: Give an owner-authorized Call/Wing turn one generic task-control surface without
 * transcript keyword routing. Ambient, Listen-Only, guest, unknown, and shared-mic turns never
 * receive this tool.
 * === VIVENTIUM END === */

const { z } = require('zod');
const { zodToJsonSchema } = require('zod-to-json-schema');
const VOICE_TASK_TOOL_NAME = 'manage_active_tasks';
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { GenerationJobManager } = require('@librechat/api');

const operationSchema = z
  .object({
    operation: z.enum(['list', 'status', 'cancel', 'retry', 'input']),
    taskId: z.string().trim().min(1).max(160).optional(),
    input: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

function ownsTask(req, task) {
  return Boolean(
    task &&
    task.callSessionId === req?.viventiumCallSession?.callSessionId &&
    (!task.userId || task.userId === String(req?.user?.id || '')),
  );
}

function publicResult(value) {
  return JSON.stringify(value);
}

function createManageActiveTasksTool(req) {
  const mode = req?.body?.mode || req?.viventiumCallSession?.mode || 'call';
  if (
    !req?.viventiumCallSession?.callSessionId ||
    !['call', 'wing'].includes(mode) ||
    req?.body?.viventiumCanAuthorizeSideEffects !== true ||
    req?.body?.viventiumActorTrust !== 'owner_participant'
  ) {
    return null;
  }

  const {
    canConfirmVoiceTaskCancellation,
    getVoiceTask,
    hydrateVoiceTask,
    hydrateVoiceTasksForCall,
    listVoiceTasks,
    retryVoiceTask,
    requestVoiceTaskOwnerCancellation,
    settleVoiceTaskCancellation,
    submitVoiceTaskInput,
  } = require('./VoiceTaskService');

  return new DynamicStructuredTool({
    name: VOICE_TASK_TOOL_NAME,
    description:
      'List, inspect, cancel, retry, or provide requested input to active call tasks. Operations are available only when the task owner advertises a real capability. Use task IDs returned by this tool.',
    schema: operationSchema,
    func: async ({ operation, taskId, input }) => {
      const userId = String(req.user.id);
      const callSessionId = req.viventiumCallSession.callSessionId;
      if (operation === 'list') {
        await hydrateVoiceTasksForCall({ userId, callSessionId });
        return publicResult({
          ok: true,
          tasks: listVoiceTasks({ userId, callSessionId }),
        });
      }
      await hydrateVoiceTask(taskId, { userId, callSessionId });
      const task = getVoiceTask(taskId);
      if (!ownsTask(req, task)) {
        return publicResult({ ok: false, code: 'task_not_found', message: 'Task not found.' });
      }
      if (operation === 'status') {
        return publicResult({ ok: true, task });
      }
      if (operation === 'input') {
        if (!input) {
          return publicResult({
            ok: false,
            code: 'input_required',
            message: 'Input is required.',
            task,
          });
        }
        return publicResult(
          await submitVoiceTaskInput(task.taskId, input, {
            userId,
            ...(req.viventiumVoiceWorkAuthority
              ? {
                  voiceAuthorityContext: {
                    callSessionId,
                    binding: req.viventiumVoiceWorkAuthority,
                  },
                }
              : {}),
          }),
        );
      }
      if (operation === 'retry') {
        return publicResult(await retryVoiceTask(task.taskId, { userId }));
      }

      const cancellation = await requestVoiceTaskOwnerCancellation(task.taskId, { userId });
      if (cancellation?.alreadyCompleted) {
        return publicResult({
          ok: false,
          code: 'already_completed',
          message: 'The task already completed and was not cancelled.',
          task: cancellation.task,
        });
      }
      if (cancellation?.alreadyCancelled) {
        return publicResult({ ok: true, task: cancellation.task });
      }
      if (cancellation?.alreadyInactive) {
        return publicResult({
          ok: false,
          code: 'not_active',
          message: 'The failed task is no longer active.',
          task: cancellation.task,
        });
      }
      if (cancellation?.ownerSupported) {
        return publicResult({ ok: true, task: cancellation.task });
      }
      let confirmed = false;
      if (!cancellation?.ownerSupported && task.streamId) {
        const result = await GenerationJobManager.abortJob(task.streamId);
        confirmed = result?.success === true;
      }
      await settleVoiceTaskCancellation(task.taskId, {
        confirmed: confirmed && canConfirmVoiceTaskCancellation(task.taskId),
        detail:
          confirmed && canConfirmVoiceTaskCancellation(task.taskId)
            ? 'The generation owner confirmed cancellation.'
            : confirmed
              ? 'Local generation stopped, but remote owner cancellation could not be confirmed; late output remains suppressed.'
              : 'The owner could not confirm cancellation; late output remains suppressed.',
      });
      return publicResult({ ok: true, task: getVoiceTask(task.taskId) });
    },
  });
}

// Reuse the owner-authorized tool through the native capability broker. Only the
// accepted voice turn can mint this resource; invocation rechecks its authority.
function voiceTaskBrokerResources(req) {
  if (!req?.viventiumVoiceWorkAuthority || !createManageActiveTasksTool(req)) return null;
  return { version: 1, authority: req.viventiumVoiceWorkAuthority };
}

async function invokeVoiceTaskBrokerTool({ user, resources, args }) {
  const authority = resources?.authority;
  if (resources?.version !== 1 || authority?.userId !== String(user?.id || '')) {
    throw new Error('voice_work_authority_stale');
  }
  await require('./VoiceWorkAuthorityService').assertVoiceWorkAuthority(authority, String(user.id));
  const session = await require('./CallSessionService').getCallSession(authority.callSessionId);
  const tool = createManageActiveTasksTool({
    user,
    viventiumCallSession: session,
    viventiumVoiceWorkAuthority: authority,
    body: {
      mode: session?.mode,
      viventiumActorTrust: 'owner_participant',
      viventiumCanAuthorizeSideEffects: true,
    },
  });
  if (!tool) throw new Error('voice_work_authority_stale');
  return { status: 'ok', tool: VOICE_TASK_TOOL_NAME, result: JSON.parse(await tool.invoke(args)) };
}

const voiceTaskBrokerDefinition = Object.freeze({
  name: VOICE_TASK_TOOL_NAME,
  description:
    'List, inspect, cancel, retry, or provide requested input to active tasks in this owner-authorized call. Use task IDs returned by this tool.',
  inputSchema: zodToJsonSchema(operationSchema, { $refStrategy: 'none' }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
});

module.exports = {
  createManageActiveTasksTool,
  operationSchema,
  VOICE_TASK_TOOL_NAME,
  voiceTaskBrokerResources,
  voiceTaskBrokerDefinition,
  invokeVoiceTaskBrokerTool,
};
