import { MAX_FEELING_STATE_TRAIL_ENTRIES } from '~/types/feelingState';
import type {
  CommitFeelingReactionParams,
  CreateFeelingStateParams,
  IFeelingState,
  UpdateFeelingStateParams,
} from '~/types/feelingState';

export function createFeelingStateMethods(mongoose: typeof import('mongoose')) {
  async function getFeelingState(userId: string): Promise<IFeelingState | null> {
    return mongoose.models.FeelingState.findOne({ userId }).lean();
  }

  async function createFeelingStateIfMissing({
    userId,
    state,
  }: CreateFeelingStateParams): Promise<IFeelingState> {
    return mongoose.models.FeelingState.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, ...state } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  }

  async function updateFeelingState({
    userId,
    expectedVersion,
    set,
    trailEntries = [],
  }: UpdateFeelingStateParams): Promise<IFeelingState | null> {
    const update: Record<string, unknown> = {
      $set: set,
      $inc: { version: 1 },
    };
    if (trailEntries.length > 0) {
      update.$push = {
        trail: { $each: trailEntries, $slice: -MAX_FEELING_STATE_TRAIL_ENTRIES },
      };
    }
    return mongoose.models.FeelingState.findOneAndUpdate(
      { userId, version: expectedVersion },
      update,
      { new: true, runValidators: true },
    ).lean();
  }

  async function updateFeelingReactionHealth({
    userId,
    health,
  }: {
    userId: string;
    health: Record<string, unknown>;
  }): Promise<IFeelingState | null> {
    return mongoose.models.FeelingState.findOneAndUpdate(
      { userId },
      { $set: { reactionHealth: health } },
      { new: true, runValidators: true },
    ).lean();
  }

  async function commitFeelingReaction({
    userId,
    expectedVersion,
    set,
    trailEntries = [],
    stimulusKey,
    health,
  }: CommitFeelingReactionParams): Promise<IFeelingState | null> {
    const push: Record<string, unknown> = {
      processedStimulusKeys: { $each: [stimulusKey], $slice: -100 },
    };
    if (trailEntries.length > 0) {
      push.trail = {
        $each: trailEntries,
        $slice: -MAX_FEELING_STATE_TRAIL_ENTRIES,
      };
    }
    return mongoose.models.FeelingState.findOneAndUpdate(
      {
        userId,
        version: expectedVersion,
        processedStimulusKeys: { $ne: stimulusKey },
      },
      {
        $set: { ...set, reactionHealth: health },
        $inc: { version: 1 },
        $push: push,
      },
      { new: true, runValidators: true },
    ).lean();
  }

  async function deleteFeelingState(userId: string, expectedVersion: number): Promise<boolean> {
    const result = await mongoose.models.FeelingState.deleteOne({
      userId,
      version: expectedVersion,
    });
    return result.deletedCount > 0;
  }

  return {
    getFeelingState,
    createFeelingStateIfMissing,
    updateFeelingState,
    updateFeelingReactionHealth,
    commitFeelingReaction,
    deleteFeelingState,
  };
}

export type FeelingStateMethods = ReturnType<typeof createFeelingStateMethods>;
