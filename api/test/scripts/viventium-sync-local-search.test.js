/* === VIVENTIUM START ===
 * Purpose: Keep startup parity checks aligned with the owning Meili eligibility contract.
 * === VIVENTIUM END === */

const fs = require('fs');
const path = require('path');

const { getState } = require('../../../scripts/viventium-sync-local-search');

describe('viventium local search sync', () => {
  test('reads parity from the owning Meili plugin progress contract', async () => {
    const Message = {
      getSyncProgress: jest.fn().mockResolvedValue({ totalDocuments: 7, totalProcessed: 5 }),
      countDocuments: jest.fn(() => {
        throw new Error('duplicate eligibility query');
      }),
    };
    const Conversation = {
      getSyncProgress: jest.fn().mockResolvedValue({ totalDocuments: 3, totalProcessed: 2 }),
      countDocuments: jest.fn(() => {
        throw new Error('duplicate eligibility query');
      }),
    };
    const client = {
      index: jest.fn((name) => ({
        getStats: jest.fn().mockResolvedValue({
          numberOfDocuments: name === 'messages' ? 5 : 2,
        }),
      })),
    };

    await expect(getState(Message, Conversation, client)).resolves.toEqual({
      msgTotal: 7,
      msgIndexed: 5,
      convoTotal: 3,
      convoIndexed: 2,
      msgMeili: 5,
      convoMeili: 2,
    });
    expect(Message.getSyncProgress).toHaveBeenCalledTimes(1);
    expect(Conversation.getSyncProgress).toHaveBeenCalledTimes(1);
    expect(Message.countDocuments).not.toHaveBeenCalled();
    expect(Conversation.countDocuments).not.toHaveBeenCalled();
  });

  test('disables Redis clients for the one-shot startup reconciliation', () => {
    const launcher = fs.readFileSync(
      path.resolve(__dirname, '../../../viventium-start.sh'),
      'utf8',
    );

    expect(launcher).toContain('USE_REDIS=false USE_REDIS_STREAMS=false node "$sync_script"');
  });
});
