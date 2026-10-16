/* === VIVENTIUM START === Keep every accepted version when embedded history reaches BSON capacity. === */
import type { Model, Types, UpdateQuery } from 'mongoose';
import type { IAgent } from '~/types/agent';

export type AgentVersionSnapshot = NonNullable<IAgent['versions']>[number];
export interface IAgentVersion {
  _id: string;
  agentObjectId: Types.ObjectId;
  index: number;
  snapshot: AgentVersionSnapshot;
}

export function agentVersionCount(agent: Pick<IAgent, 'version_count' | 'versions'>): number {
  return agent.version_count ?? agent.versions?.length ?? 0;
}

export function isAgentBsonOverflow(error: { code?: number; codeName?: string }): boolean {
  return error.code === 10334 || error.codeName === 'BSONObjectTooLarge';
}

export function createAgentVersionMethods(
  Agent: Model<IAgent>,
  AgentVersion: Model<IAgentVersion>,
) {
  const key = (agent: IAgent, index: number) => `${agent._id.toString()}:${index}`;
  const conflict = () =>
    Object.assign(
      new Error('Agent changed during save. Reload its current settings before saving again.'),
      { code: 'agent_version_conflict', statusCode: 409 },
    );

  async function getVersions(agent: IAgent): Promise<AgentVersionSnapshot[]> {
    if (agent.version_count == null) return agent.versions ?? [];
    const records = await AgentVersion.find({
      agentObjectId: agent._id,
      index: { $lt: agent.version_count },
    })
      .sort({ index: 1 })
      .lean();
    if (
      records.length !== agent.version_count ||
      records.some((row, index) => row.index !== index)
    ) {
      throw new Error('Agent version history is incomplete');
    }
    return records.map((row) => row.snapshot as AgentVersionSnapshot);
  }

  async function getVersion(agent: IAgent, index: number): Promise<AgentVersionSnapshot | null> {
    if (!Number.isInteger(index) || index < 0 || index >= agentVersionCount(agent)) return null;
    if (agent.version_count == null) return agent.versions?.[index] ?? null;
    const record = await AgentVersion.findById(key(agent, index)).lean();
    return record ? (record.snapshot as AgentVersionSnapshot) : null;
  }

  async function saveArchivedUpdate(
    current: IAgent,
    update: UpdateQuery<IAgent>,
    snapshot: AgentVersionSnapshot | null,
  ): Promise<IAgent> {
    const hello = await Agent.db.db?.admin().command({ hello: 1 });
    if (!hello?.setName && hello?.msg !== 'isdbgrid') {
      throw Object.assign(
        new Error(
          'Agent history reached MongoDB document capacity. Atomic history storage needs a replica set.',
        ),
        {
          code: 'agent_history_transactions_required',
        },
      );
    }
    await AgentVersion.createCollection();
    const session = await Agent.db.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const count = agentVersionCount(current);
        try {
          if (current.version_count == null && current.versions?.length) {
            await AgentVersion.insertMany(
              current.versions.map((entry, index) => ({
                _id: key(current, index),
                agentObjectId: current._id,
                index,
                snapshot: entry,
              })),
              { session },
            );
          }
          if (snapshot) {
            await AgentVersion.create(
              [
                {
                  _id: key(current, count),
                  agentObjectId: current._id,
                  index: count,
                  snapshot,
                },
              ],
              { session },
            );
          }
        } catch (error) {
          if (
            typeof error === 'object' &&
            error != null &&
            'code' in error &&
            error.code === 11000
          ) {
            throw conflict();
          }
          throw error;
        }
        const push = { ...update.$push };
        delete push.versions;
        const write: UpdateQuery<IAgent> = {
          ...update,
          $set: { ...update.$set, version_count: count + (snapshot ? 1 : 0) },
          $unset: { ...update.$unset, versions: 1 },
          $inc: { ...update.$inc, __v: 1 },
        };
        delete write.$push;
        if (Object.keys(push).length) write.$push = push;
        const saved = await Agent.findOneAndUpdate(
          { _id: current._id, updatedAt: current.updatedAt, __v: current.__v },
          write,
          { new: true, session },
        ).lean();
        if (!saved) {
          throw conflict();
        }
        return saved as IAgent;
      });
      if (!result) throw new Error('Agent history transaction did not commit');
      return result;
    } finally {
      await session.endSession();
    }
  }
  return { getVersions, getVersion, saveArchivedUpdate };
}
/* === VIVENTIUM END === */
