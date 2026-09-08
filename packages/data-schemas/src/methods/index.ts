import { createSessionMethods, DEFAULT_REFRESH_TOKEN_EXPIRY, type SessionMethods } from './session';
import { createTokenMethods, type TokenMethods } from './token';
import { createRoleMethods, type RoleMethods } from './role';
import { createUserMethods, DEFAULT_SESSION_EXPIRY, type UserMethods } from './user';

export { DEFAULT_REFRESH_TOKEN_EXPIRY, DEFAULT_SESSION_EXPIRY };
import { createKeyMethods, type KeyMethods } from './key';
import { createFileMethods, type FileMethods } from './file';
/* Memories */
import { createMemoryMethods, type MemoryMethods } from './memory';
import { createMemoryWriteMethods, type MemoryWriteMethods } from './memoryWrite';
import { createNativeResponseMethods } from './nativeResponse';
import { createMainContinuityMethods } from './mainContinuity';
export { mainContinuityStorageKey, mainContinuityMessageEvidence } from './mainContinuity';
import type { MainContinuityMethods } from './mainContinuity';
import { createFeelingStateMethods, type FeelingStateMethods } from './feelingState';
/* Agent Categories */
import { createAgentCategoryMethods, type AgentCategoryMethods } from './agentCategory';
/* Agent API Keys */
import { createAgentApiKeyMethods, type AgentApiKeyMethods } from './agentApiKey';
/* MCP Servers */
import { createMCPServerMethods, type MCPServerMethods } from './mcpServer';
/* Plugin Auth */
import { createPluginAuthMethods, type PluginAuthMethods } from './pluginAuth';
/* Permissions */
import { createAccessRoleMethods, type AccessRoleMethods } from './accessRole';
import { createUserGroupMethods, type UserGroupMethods } from './userGroup';
import { createAclEntryMethods, type AclEntryMethods } from './aclEntry';
import { createShareMethods, type ShareMethods } from './share';
import { createTransactionMethods, type TransactionMethods } from './transaction';

export type AllMethods = UserMethods &
  SessionMethods &
  TokenMethods &
  RoleMethods &
  KeyMethods &
  FileMethods &
  MemoryMethods &
  MemoryWriteMethods &
  MainContinuityMethods &
  FeelingStateMethods &
  AgentCategoryMethods &
  AgentApiKeyMethods &
  MCPServerMethods &
  UserGroupMethods &
  AclEntryMethods &
  ShareMethods &
  AccessRoleMethods &
  PluginAuthMethods &
  TransactionMethods;

/**
 * Creates all database methods for all collections
 * @param mongoose - Mongoose instance
 */
export function createMethods(mongoose: typeof import('mongoose')): AllMethods {
  return {
    ...createUserMethods(mongoose),
    ...createSessionMethods(mongoose),
    ...createTokenMethods(mongoose),
    ...createRoleMethods(mongoose),
    ...createKeyMethods(mongoose),
    ...createFileMethods(mongoose),
    ...createMemoryMethods(mongoose),
    ...createMemoryWriteMethods(mongoose),
    ...createNativeResponseMethods(mongoose),
    ...createMainContinuityMethods(mongoose),
    ...createFeelingStateMethods(mongoose),
    ...createAgentCategoryMethods(mongoose),
    ...createAgentApiKeyMethods(mongoose),
    ...createMCPServerMethods(mongoose),
    ...createAccessRoleMethods(mongoose),
    ...createUserGroupMethods(mongoose),
    ...createAclEntryMethods(mongoose),
    ...createShareMethods(mongoose),
    ...createPluginAuthMethods(mongoose),
    ...createTransactionMethods(mongoose),
  };
}

export type {
  UserMethods,
  SessionMethods,
  TokenMethods,
  RoleMethods,
  KeyMethods,
  FileMethods,
  MemoryMethods,
  MemoryWriteMethods,
  FeelingStateMethods,
  AgentCategoryMethods,
  AgentApiKeyMethods,
  MCPServerMethods,
  UserGroupMethods,
  AclEntryMethods,
  ShareMethods,
  AccessRoleMethods,
  PluginAuthMethods,
  TransactionMethods,
};
