/* === VIVENTIUM START ===
 * A durable result uses ordinary Main context preparation without starting another generation.
 * Persistence, tools, callbacks and delivery remain with their existing owners.
 * === VIVENTIUM END === */
import type { IncomingHttpHeaders } from 'node:http';
import cloneDeep from 'lodash/cloneDeep';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { Agent, TMessage } from 'librechat-data-provider';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { RequestBody } from '~/types';
import type { InteractionSourceSegment } from '../glasshive/interactionSourceSegments';
import type { GlassHiveSourceAuthorBody } from '../glasshive/sourceAuthor';

export type MainAuthorUser = Pick<IUser, '_id' | 'id' | 'role' | 'email' | 'personalization'>;

export interface MainAuthorRequest {
  user: MainAuthorUser;
  config: AppConfig;
  headers: IncomingHttpHeaders;
  body: RequestBody &
    GlassHiveSourceAuthorBody & {
      streamId?: string;
      agent_id?: string;
      text: string;
      viventiumSourceEventId: string;
      viventiumTriggeringSourceSegments: InteractionSourceSegment[];
      viventiumResultAuthor?: { scope: string; messageId: string } | null;
    };
}

interface MainAuthorClient {
  conversationId: string;
  responseMessageId: string;
  prepareMainResultContext(
    messages: TMessage[],
    parentMessageId: string,
  ): Promise<{
    instructions: string;
    memoryContext: string;
    messages: BaseMessage[];
    selectedCarrierBytes?: number;
    developerInstructionTail?: string;
  }>;
}

export async function prepareMainAuthorContext(
  input: {
    ownerId: string;
    agent: Agent;
    conversationId: string;
    parentMessageId: string;
    messageId: string;
    text: string;
    sourceEventId: string;
    sourceSegments: readonly InteractionSourceSegment[];
    messages: TMessage[];
    request: { body?: RequestBody; headers?: IncomingHttpHeaders };
  },
  deps: {
    readUser: (ownerId: string) => Promise<MainAuthorUser | null>;
    readConfig: (role?: string) => Promise<AppConfig>;
    bindRequest: (req: MainAuthorRequest) => void;
    createClient: (req: MainAuthorRequest, agent: Agent) => Promise<MainAuthorClient>;
  },
): Promise<{
  req: MainAuthorRequest;
  instructions: string;
  memoryContext: string;
  messages: BaseMessage[];
  selectedCarrierBytes?: number;
  developerInstructionTail?: string;
}> {
  const user = await deps.readUser(input.ownerId);
  if (!user) throw new Error('main_author_unavailable');
  const req: MainAuthorRequest = {
    user: { ...user, id: String(user.id || user._id) },
    config: await deps.readConfig(user.role),
    headers: { ...input.request.headers },
    body: {
      ...cloneDeep(input.request.body),
      conversationId: input.conversationId,
      agent_id: input.agent.id,
      parentMessageId: input.parentMessageId,
      messageId: input.messageId,
      text: input.sourceSegments.map((source) => source.text).join('\n\n'),
      viventiumSourceEventId: input.sourceEventId,
      viventiumTriggeringSourceSegments: cloneDeep([...input.sourceSegments]),
    },
  };
  delete req.body.viventiumGlassHiveTurnContextB64;
  delete req.body.viventiumGlassHiveIdempotencyKey;
  delete req.body.viventiumStreamId;
  delete req.body.streamId;
  delete req.body.viventiumLogicalTurnId;
  delete req.body.viventiumLogicalTurnRevision;
  delete req.body.viventiumAuthoringSourceEventId;
  delete req.body.viventiumAuthoringSourceRevision;
  delete req.body.viventiumResultAuthor;
  deps.bindRequest(req);
  const client = await deps.createClient(req, cloneDeep(input.agent));
  client.conversationId = input.conversationId;
  client.responseMessageId = input.messageId;
  const context = await client.prepareMainResultContext(
    [
      ...cloneDeep(input.messages),
      {
        messageId: input.messageId,
        parentMessageId: input.parentMessageId,
        conversationId: input.conversationId,
        text: input.text,
        // Human transport for evidence, with system provenance bound on the request. Not persisted.
        sender: 'User',
        isCreatedByUser: true,
      } as TMessage,
    ],
    input.messageId,
  );
  return { req, ...context };
}
/* === VIVENTIUM END === */
