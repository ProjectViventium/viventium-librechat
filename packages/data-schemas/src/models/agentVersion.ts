/* === VIVENTIUM START === Immutable Agent history outside the current BSON document. === */
import { Schema } from 'mongoose';
import type { IAgentVersion } from '~/methods/agentVersions';

export function createAgentVersionModel(mongoose: typeof import('mongoose')) {
  const schema = new Schema<IAgentVersion>(
    {
      _id: { type: String, required: true },
      agentObjectId: { type: Schema.Types.ObjectId, required: true },
      index: { type: Number, required: true, min: 0 },
      snapshot: { type: Schema.Types.Mixed, required: true },
    },
    { versionKey: false },
  );
  schema.index({ agentObjectId: 1, index: 1 });
  return mongoose.models.AgentVersion || mongoose.model<IAgentVersion>('AgentVersion', schema);
}
/* === VIVENTIUM END === */
