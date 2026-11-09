/* Provider/persistence unit tests keep cognition in its separately tested ordinary Main owner. */
const { HumanMessage, AIMessage } = require('@librechat/agents/langchain/messages');

function mockMainAuthorContext(prepare, input, dependencies) {
  const source = input.request || {};
  return prepare(input, {
    ...dependencies,
    readUser: async () =>
      source.user || { id: input.ownerId, _id: input.ownerId, email: 'qa@example.invalid' },
    readConfig: async () => source.config || {},
    createClient: async (req) => ({
      conversationId: '',
      responseMessageId: '',
      prepareMainResultContext: async (messages) => {
        for (const [key, value] of Object.entries(source)) {
          if (key.startsWith('_viventiumGlassHiveWorker') || key === '_viventiumFeelingSnapshot')
            req[key] = value;
        }
        return {
          instructions: input.agent.instructions || '',
          memoryContext: '',
          messages: messages.map((message) => {
            const Message = message.isCreatedByUser === false ? AIMessage : HumanMessage;
            return new Message(message.text || message.content || '');
          }),
        };
      },
    }),
  });
}

module.exports = { mockMainAuthorContext };
