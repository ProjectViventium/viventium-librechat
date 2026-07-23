import { createUserModel } from './user';
import { createTokenModel } from './token';
import { createSessionModel } from './session';
import { createBalanceModel } from './balance';
import { createConversationModel } from './convo';
import { createMessageModel } from './message';
import { createAgentModel } from './agent';
import { createAgentApiKeyModel } from './agentApiKey';
import { createAgentCategoryModel } from './agentCategory';
import { createMCPServerModel } from './mcpServer';
import { createRoleModel } from './role';
import { createActionModel } from './action';
import { createAssistantModel } from './assistant';
import { createFileModel } from './file';
import { createBannerModel } from './banner';
import { createProjectModel } from './project';
import { createKeyModel } from './key';
import { createPluginAuthModel } from './pluginAuth';
import { createTransactionModel } from './transaction';
import { createPresetModel } from './preset';
import { createPromptModel } from './prompt';
import { createPromptGroupModel } from './promptGroup';
import { createConversationTagModel } from './conversationTag';
import { createSharedLinkModel } from './sharedLink';
import { createToolCallModel } from './toolCall';
import { createMemoryModel } from './memory';
import { createFeelingStateModel } from './feelingState';
import { createAccessRoleModel } from './accessRole';
import { createAclEntryModel } from './aclEntry';
import { createGroupModel } from './group';
/* === VIVENTIUM START ===
 * Feature: Channel-neutral messaging persistence.
 * Purpose: Export typed models while preserving legacy Gateway model names/collections.
 * === VIVENTIUM END === */
import { createChannelConnectionModel } from './channelConnection';
import { createChannelThreadModel } from './channelThread';
import { createGatewayUserMappingModel } from './gatewayUserMapping';
import { createGatewayLinkTokenModel } from './gatewayLinkToken';
import { createViventiumGatewayIngressEventModel } from './viventiumGatewayIngressEvent';
import { createChannelPairingCodeModel } from './channelPairingCode';
import { createChannelPairingAttemptModel } from './channelPairingAttempt';
import { createChannelWorkerLeaseModel } from './channelWorkerLease';
import { createChannelDeliveryModel } from './channelDelivery';
import { createChannelIngressQuotaModel } from './channelIngressQuota';

/**
 * Creates all database models for all collections
 */
export function createModels(mongoose: typeof import('mongoose')) {
  return {
    User: createUserModel(mongoose),
    Token: createTokenModel(mongoose),
    Session: createSessionModel(mongoose),
    Balance: createBalanceModel(mongoose),
    Conversation: createConversationModel(mongoose),
    Message: createMessageModel(mongoose),
    Agent: createAgentModel(mongoose),
    AgentApiKey: createAgentApiKeyModel(mongoose),
    AgentCategory: createAgentCategoryModel(mongoose),
    MCPServer: createMCPServerModel(mongoose),
    Role: createRoleModel(mongoose),
    Action: createActionModel(mongoose),
    Assistant: createAssistantModel(mongoose),
    File: createFileModel(mongoose),
    Banner: createBannerModel(mongoose),
    Project: createProjectModel(mongoose),
    Key: createKeyModel(mongoose),
    PluginAuth: createPluginAuthModel(mongoose),
    Transaction: createTransactionModel(mongoose),
    Preset: createPresetModel(mongoose),
    Prompt: createPromptModel(mongoose),
    PromptGroup: createPromptGroupModel(mongoose),
    ConversationTag: createConversationTagModel(mongoose),
    SharedLink: createSharedLinkModel(mongoose),
    ToolCall: createToolCallModel(mongoose),
    MemoryEntry: createMemoryModel(mongoose),
    FeelingState: createFeelingStateModel(mongoose),
    AccessRole: createAccessRoleModel(mongoose),
    AclEntry: createAclEntryModel(mongoose),
    Group: createGroupModel(mongoose),
    ChannelConnection: createChannelConnectionModel(mongoose),
    ChannelThread: createChannelThreadModel(mongoose),
    GatewayUserMapping: createGatewayUserMappingModel(mongoose),
    GatewayLinkToken: createGatewayLinkTokenModel(mongoose),
    ViventiumGatewayIngressEvent: createViventiumGatewayIngressEventModel(mongoose),
    ChannelPairingCode: createChannelPairingCodeModel(mongoose),
    ChannelPairingAttempt: createChannelPairingAttemptModel(mongoose),
    ChannelWorkerLease: createChannelWorkerLeaseModel(mongoose),
    ChannelDelivery: createChannelDeliveryModel(mongoose),
    ChannelIngressQuota: createChannelIngressQuotaModel(mongoose),
  };
}
