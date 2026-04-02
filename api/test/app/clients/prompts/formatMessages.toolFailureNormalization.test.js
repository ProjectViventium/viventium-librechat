const { ContentTypes, Tools } = require('librechat-data-provider');
const { formatAgentMessages } = require('~/app/clients/prompts/formatMessages');
const {
  FILE_SEARCH_NO_RETRIEVED_EVIDENCE,
  WEB_SEARCH_NO_RELEVANT_EVIDENCE,
} = require('~/app/clients/tools/util/modelFacingToolOutput');

describe('formatAgentMessages tool failure normalization', () => {
  test('rewrites legacy file_search diagnostics before creating ToolMessage', () => {
    const messages = formatAgentMessages([
      {
        role: 'assistant',
        content: [
          {
            type: ContentTypes.TEXT,
            text: 'Looking through the files.',
            [ContentTypes.TEXT]: 'Looking through the files.',
            tool_call_ids: ['call_1'],
          },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'call_1',
              name: Tools.file_search,
              args: '{"query":"second evidence document"}',
              output: 'File search encountered errors or timed out. Please try again or rephrase your query.',
            },
          },
        ],
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe(FILE_SEARCH_NO_RETRIEVED_EVIDENCE);
  });

  test('rewrites legacy web_search diagnostics before creating ToolMessage', () => {
    const messages = formatAgentMessages([
      {
        role: 'assistant',
        content: [
          {
            type: ContentTypes.TEXT,
            text: 'Checking the web.',
            [ContentTypes.TEXT]: 'Checking the web.',
            tool_call_ids: ['call_2'],
          },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'call_2',
              name: Tools.web_search,
              args: '{"query":"latest o-1 criteria"}',
              output: 'No safe relevant web results found for this query.',
            },
          },
        ],
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe(WEB_SEARCH_NO_RELEVANT_EVIDENCE);
  });
});
