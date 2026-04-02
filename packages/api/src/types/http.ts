import type { IUser, AppConfig } from '@librechat/data-schemas';
import type { TEndpointOption } from 'librechat-data-provider';
import type { Request } from 'express';

/**
 * LibreChat-specific request body type that extends Express Request body
 * (have to use type alias because you can't extend indexed access types like Request['body'])
 */
export type RequestBody = {
  messageId?: string;
  fileTokenLimit?: number;
  conversationId?: string;
  parentMessageId?: string;
  /* === VIVENTIUM START ===
   * Feature: Timezone-aware request metadata
   * Purpose: Allow clients to provide an IANA timezone for downstream time-context rendering ({{current_datetime}}) and scheduling.
   * Added: 2026-02-07
   */
  clientTimezone?: string;
  /* === VIVENTIUM END === */
  endpoint?: string;
  endpointType?: string;
  model?: string;
  key?: string;
  endpointOption?: Partial<TEndpointOption>;
};

export type ServerRequest = Request<unknown, unknown, RequestBody> & {
  user?: IUser;
  config?: AppConfig;
};
