import type { Document, Types } from 'mongoose';
import { CursorPaginationParams } from '~/common';

export interface ViventiumVoiceRouteSelection {
  provider?: string | null;
  variant?: string | null;
}

export interface ViventiumVoiceRouteState {
  stt?: ViventiumVoiceRouteSelection | null;
  tts?: ViventiumVoiceRouteSelection | null;
}

export interface IUser extends Document {
  name?: string;
  username?: string;
  email: string;
  emailVerified: boolean;
  password?: string;
  avatar?: string;
  provider: string;
  role?: string;
  googleId?: string;
  facebookId?: string;
  openidId?: string;
  samlId?: string;
  ldapId?: string;
  githubId?: string;
  discordId?: string;
  appleId?: string;
  plugins?: string[];
  twoFactorEnabled?: boolean;
  totpSecret?: string;
  backupCodes?: Array<{
    codeHash: string;
    used: boolean;
    usedAt?: Date | null;
  }>;
  refreshToken?: Array<{
    refreshToken: string;
  }>;
  expiresAt?: Date;
  termsAccepted?: boolean;
  personalization?: {
    memories?: boolean;
    /* === VIVENTIUM START ===
     * Feature: Global conversation recall personalization toggle
     * Added: 2026-02-19
     */
    conversation_recall?: boolean;
    /* === VIVENTIUM END === */
  };
  favorites?: Array<{
    agentId?: string;
    model?: string;
    endpoint?: string;
  }>;
  createdAt?: Date;
  updatedAt?: Date;
  /* === VIVENTIUM START ===
   * Feature: Registration approval status fields.
   * Purpose: Support pending/approved/denied onboarding workflow.
   * === VIVENTIUM END === */
  viventiumApprovalStatus?: 'pending' | 'approved' | 'denied';
  viventiumApprovalRequestedAt?: Date | null;
  viventiumApprovalReviewedAt?: Date | null;
  /* === VIVENTIUM START ===
   * Feature: Modern playground voice-route persistence
   * Purpose: Store per-user STT/TTS defaults for the LiveKit playground.
   * === VIVENTIUM END === */
  viventiumVoicePreferences?: {
    livekitPlayground?: ViventiumVoiceRouteState | null;
  };
  /** Field for external source identification (for consistency with TPrincipal schema) */
  idOnTheSource?: string;
}

export interface BalanceConfig {
  enabled?: boolean;
  startBalance?: number;
  autoRefillEnabled?: boolean;
  refillIntervalValue?: number;
  refillIntervalUnit?: string;
  refillAmount?: number;
}

export interface CreateUserRequest extends Partial<IUser> {
  email: string;
}

export interface UpdateUserRequest {
  name?: string;
  username?: string;
  email?: string;
  role?: string;
  emailVerified?: boolean;
  avatar?: string;
  plugins?: string[];
  twoFactorEnabled?: boolean;
  termsAccepted?: boolean;
  personalization?: {
    memories?: boolean;
    /* === VIVENTIUM START ===
     * Feature: Global conversation recall personalization toggle
     * Added: 2026-02-19
     */
    conversation_recall?: boolean;
    /* === VIVENTIUM END === */
  };
  /* === VIVENTIUM START ===
   * Feature: Registration approval status fields.
   * === VIVENTIUM END === */
  viventiumApprovalStatus?: 'pending' | 'approved' | 'denied';
  viventiumApprovalRequestedAt?: Date | null;
  viventiumApprovalReviewedAt?: Date | null;
  viventiumVoicePreferences?: {
    livekitPlayground?: ViventiumVoiceRouteState | null;
  };
}

export interface UserDeleteResult {
  deletedCount: number;
  message: string;
}

export interface UserFilterOptions extends CursorPaginationParams {
  _id?: Types.ObjectId | string;
  // Includes email, username and name
  search?: string;
  role?: string;
  emailVerified?: boolean;
  provider?: string;
  twoFactorEnabled?: boolean;
  // External IDs
  googleId?: string;
  facebookId?: string;
  openidId?: string;
  samlId?: string;
  ldapId?: string;
  githubId?: string;
  discordId?: string;
  appleId?: string;
  // Date filters
  createdAfter?: string;
  createdBefore?: string;
}

export interface UserQueryOptions {
  fieldsToSelect?: string | string[] | null;
  lean?: boolean;
}
