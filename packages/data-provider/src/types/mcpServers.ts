import type { MCPOptions, MCPServerUserInput } from '../mcp';

/**
 * Base MCP Server interface
 * Core structure shared between API and database layers
 */
export interface IMCPServerDB {
  _id?: string; // MongoDB ObjectId (used for ACL/permissions)
  serverName: string;
  config: MCPOptions;
  author?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * User-managed MCP Server (standalone, not attached to agent)
 * API type for frontend/backend communication
 * Similar to Agent type - includes populated author fields
 */
export type MCPServerDB = IMCPServerDB;

/**
 * Parameters for creating a new user-managed MCP server
 * Note: Only UI-editable fields are allowed (excludes server-managed fields)
 */
export type MCPServerCreateParams = {
  config: MCPServerUserInput; // UI fields only (title, description, url, oauth, iconPath)
};

/**
 * Parameters for updating an existing user-managed MCP server
 * Note: Only UI-editable fields are allowed (excludes server-managed fields)
 */
export type MCPServerUpdateParams = {
  config?: MCPServerUserInput; // UI fields only (title, description, url, oauth, iconPath)
};

/**
 * Response for MCP server list endpoint
 */
export type MCPServerDBObjectResponse = {
  dbId?: string;
  serverName: string;
  /** True if access is only via agent (not directly shared with user) */
  consumeOnly?: boolean;
} & MCPOptions;

export type MCPServersListResponse = Record<string, MCPServerDBObjectResponse>;

export type NativeQuestionContent = {
  answers: Record<string, string[]>;
  annotations?: Record<string, { notes: string }>;
};
export type NativeQuestionForm = {
  questions: Array<{
    key: string;
    label: string;
    multiSelect: boolean;
    options: Array<{ value: string; label: string }>;
  }>;
};
export type NativeQuestionSchema = {
  type: 'object';
  required: ['answers'];
  additionalProperties: false;
  properties: {
    answers: {
      type: 'object';
      minProperties: 1;
      maxProperties: 16;
      additionalProperties: false;
      properties: Record<
        string,
        {
          title?: string;
          type: 'array';
          uniqueItems: true;
          minItems: 1;
          maxItems: number;
          items: { type: 'string'; enum: string[] };
        }
      >;
    };
    annotations: {
      type: 'object';
      additionalProperties: false;
      properties: Record<
        string,
        {
          type: 'object';
          additionalProperties: false;
          required: ['notes'];
          properties: { notes: { type: 'string'; minLength: 1; maxLength: 8000 } };
        }
      >;
    };
  };
};

/** Owner response to one pending native request; never inferred from a Resume action. */
export type NativeWorkInputResponse = {
  version: 1;
  requestId: string;
  requestFingerprint: string;
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]> | NativeQuestionContent;
};

type PendingNativeWorkInputBase = {
  version: 1;
  requestId: string;
  requestFingerprint: string;
  message: string;
  mode: 'form' | 'url';
  requestedSchema?: import('@modelcontextprotocol/sdk/types.js').ElicitRequestFormParams['requestedSchema'];
  url?: string;
  elicitationId?: string;
  title?: string;
  state: 'pending';
};

/* === VIVENTIUM START === Native permission and MCP forms share the existing owner response UI. === VIVENTIUM END === */
export type PendingNativeWorkInput =
  | (PendingNativeWorkInputBase &
      (
        | { kind: 'elicitation'; mcpServerName: string }
        | {
            kind: 'permission';
            runtimeName: string;
            mode: 'form';
            runId: string;
            attemptId: string;
            sessionId: string;
            expiresAt: string;
          }
      ))
  | (Omit<PendingNativeWorkInputBase, 'requestedSchema'> & {
      kind: 'question';
      runtimeName: string;
      mode: 'form';
      runId: string;
      attemptId: string;
      sessionId: string;
      expiresAt: string;
      requestedSchema: NativeQuestionSchema;
    });
