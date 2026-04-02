import { Schema } from 'mongoose';
import { SystemRoles } from 'librechat-data-provider';
import { IUser } from '~/types';

// Session sub-schema
const SessionSchema = new Schema(
  {
    refreshToken: {
      type: String,
      default: '',
    },
  },
  { _id: false },
);

// Backup code sub-schema
const BackupCodeSchema = new Schema(
  {
    codeHash: { type: String, required: true },
    used: { type: Boolean, default: false },
    usedAt: { type: Date, default: null },
  },
  { _id: false },
);

/* === VIVENTIUM START ===
 * Feature: Modern playground voice-route persistence
 * Purpose: Reuse a normalized provider/variant shape for per-user voice defaults.
 * === VIVENTIUM END === */
const ViventiumVoiceRouteSelectionSchema = new Schema(
  {
    provider: {
      type: String,
      default: null,
    },
    variant: {
      type: String,
      default: null,
    },
  },
  { _id: false },
);

const ViventiumVoiceRouteStateSchema = new Schema(
  {
    stt: {
      type: ViventiumVoiceRouteSelectionSchema,
      default: null,
    },
    tts: {
      type: ViventiumVoiceRouteSelectionSchema,
      default: null,
    },
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
    },
    username: {
      type: String,
      lowercase: true,
      default: '',
    },
    email: {
      type: String,
      required: [true, "can't be blank"],
      lowercase: true,
      unique: true,
      match: [/\S+@\S+\.\S+/, 'is invalid'],
      index: true,
    },
    emailVerified: {
      type: Boolean,
      required: true,
      default: false,
    },
    password: {
      type: String,
      trim: true,
      minlength: 8,
      maxlength: 128,
      select: false,
    },
    avatar: {
      type: String,
      required: false,
    },
    provider: {
      type: String,
      required: true,
      default: 'local',
    },
    role: {
      type: String,
      default: SystemRoles.USER,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
    },
    facebookId: {
      type: String,
      unique: true,
      sparse: true,
    },
    openidId: {
      type: String,
      unique: true,
      sparse: true,
    },
    samlId: {
      type: String,
      unique: true,
      sparse: true,
    },
    ldapId: {
      type: String,
      unique: true,
      sparse: true,
    },
    githubId: {
      type: String,
      unique: true,
      sparse: true,
    },
    discordId: {
      type: String,
      unique: true,
      sparse: true,
    },
    appleId: {
      type: String,
      unique: true,
      sparse: true,
    },
    plugins: {
      type: Array,
    },
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    totpSecret: {
      type: String,
      select: false,
    },
    backupCodes: {
      type: [BackupCodeSchema],
      select: false,
    },
    refreshToken: {
      type: [SessionSchema],
    },
    expiresAt: {
      type: Date,
      expires: 604800, // 7 days in seconds
    },
    termsAccepted: {
      type: Boolean,
      default: false,
    },
    personalization: {
      type: {
        memories: {
          type: Boolean,
          default: true,
        },
        /* === VIVENTIUM START ===
         * Feature: Global conversation recall personalization toggle
         * Purpose: Controls whether agents can semantically retrieve from the user's full chat history.
         * Added: 2026-02-19
         */
        conversation_recall: {
          type: Boolean,
          default: false,
        },
        /* === VIVENTIUM END === */
      },
      default: {},
    },
    favorites: {
      type: [
        {
          _id: false,
          agentId: String, // for agent
          model: String, // for model
          endpoint: String, // for model
        },
      ],
      default: [],
    },
    /* === VIVENTIUM START ===
     * Feature: Registration approval workflow fields.
     * Purpose: Gate authentication for newly registered users until admin approval.
     *
     * Note:
     * - default 'approved' keeps existing users unlocked without a migration script.
     * - new users are explicitly set to 'pending' when approval mode is enabled.
     * === VIVENTIUM END === */
    viventiumApprovalStatus: {
      type: String,
      enum: ['pending', 'approved', 'denied'],
      default: 'approved',
    },
    viventiumApprovalRequestedAt: {
      type: Date,
      default: null,
    },
    viventiumApprovalReviewedAt: {
      type: Date,
      default: null,
    },
    /* === VIVENTIUM START ===
     * Feature: Modern playground voice-route persistence
     * Purpose: Persist per-user STT/TTS defaults outside generic personalization.
     * === VIVENTIUM END === */
    viventiumVoicePreferences: {
      type: {
        livekitPlayground: {
          type: ViventiumVoiceRouteStateSchema,
          default: null,
        },
      },
      default: {},
    },
    /** Field for external source identification (for consistency with TPrincipal schema) */
    idOnTheSource: {
      type: String,
      sparse: true,
    },
  },
  { timestamps: true },
);

export default userSchema;
