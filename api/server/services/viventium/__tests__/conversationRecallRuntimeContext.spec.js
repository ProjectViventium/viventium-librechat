/* === VIVENTIUM START ===
 * Tests: Conversation Recall runtime fallback context
 *
 * Purpose:
 * - Validate that runtime recall context is produced when enabled by policy.
 * - Ensure current-conversation messages are excluded from fallback retrieval.
 * - Ensure fallback respects agent-scoped policy and fast-exits on non-recall prompts.
 *
 * Added: 2026-02-19
 * === VIVENTIUM END === */

const mockUserFindById = jest.fn();
const mockConversationFind = jest.fn();
const mockMessageFind = jest.fn();

jest.mock('~/db/models', () => ({
  User: {
    findById: (...args) => mockUserFindById(...args),
  },
  Conversation: {
    find: (...args) => mockConversationFind(...args),
  },
  Message: {
    find: (...args) => mockMessageFind(...args),
  },
}));

jest.mock('librechat-data-provider', () => ({
  parseTextParts: jest.fn((parts) =>
    Array.isArray(parts)
      ? parts
          .map((part) =>
            typeof part?.text === 'string'
              ? part.text
              : typeof part?.think === 'string'
                ? part.think
                : '',
          )
          .filter(Boolean)
          .join(' ')
      : '',
  ),
}));

function queryResult(result) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

function loadService() {
  return require('../conversationRecallRuntimeContext');
}

describe('conversationRecallRuntimeContext', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_ENABLED = 'true';
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_MESSAGES = '1200';
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_FETCH_MULTIPLIER = '4';
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_SCAN_MESSAGES = '8000';
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_MATCHES = '6';
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MIN_SCORE = '1.2';
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_INCLUDE_ASSISTANT = 'true';
  });

  test('returns fallback context for global recall and excludes current conversation', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'current_convo',
          createdAt: '2026-02-19T01:00:00.000Z',
          isCreatedByUser: true,
          text: 'Remember when I shared my lab test results?',
        },
        {
          conversationId: 'prior_convo',
          createdAt: '2026-02-18T01:00:00.000Z',
          isCreatedByUser: true,
          text: 'Lab test results from June: ferritin was low.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'current_convo',
        text: 'Remember when I shared my lab test results?',
      },
    });

    expect(context).toContain('Conversation Recall Context');
    expect(context).toContain('conversation=prior_convo');
    expect(context).not.toContain('conversation=current_convo');
  });

  test('uses agent-scoped policy and limits retrieval to conversations tied to that agent', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: false },
      }),
    );
    mockConversationFind.mockReturnValue(queryResult([{ conversationId: 'agent_convo_1' }]));
    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'agent_convo_1',
          createdAt: '2026-02-18T04:00:00.000Z',
          isCreatedByUser: true,
          text: 'My lab panel showed LDL 165 and HDL 42, and I asked for interpretation.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_42', conversation_recall_agent_only: true },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'Can you recall my previous lab panel discussion?',
      },
    });

    expect(mockConversationFind).toHaveBeenCalledWith({
      user: 'user_1',
      agent_id: 'agent_42',
    });
    expect(mockMessageFind).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user_1',
        conversationId: { $in: ['agent_convo_1'] },
      }),
    );
    expect(context).toContain('conversation=agent_convo_1');
  });

  test('fast-exits on non-recall prompts', async () => {
    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'convo_1',
        text: 'Hi',
      },
    });

    expect(context).toBe('');
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockMessageFind).not.toHaveBeenCalled();
  });

  test('falls back to authenticated account display name for name queries when no snippets match', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(queryResult([]));

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1', name: 'Avery B' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: "What's my name?",
      },
    });

    expect(context).toContain('conversation=user_profile');
    expect(context).toContain('Avery B');
  });

  test('includes assistant snippets when they contain the strongest recall details', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'lab_convo',
          createdAt: '2026-02-10T03:23:43.739Z',
          isCreatedByUser: false,
          sender: 'Viventium',
          text: 'Deep dive: WBC 5.2, RBC 4.78, Hemoglobin 140, platelets 244. LDL 165 and HDL 42.',
        },
        {
          conversationId: 'lab_convo',
          createdAt: '2026-02-10T03:22:54.486Z',
          isCreatedByUser: true,
          text: 'Lab results are in, I attached the report for you.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'Remember my cholesterol lab values from before?',
      },
    });

    expect(context).toContain('conversation=lab_convo');
    expect(context).toContain('Hemoglobin 140');
    expect(context).toContain('LDL 165');
    expect(mockMessageFind).toHaveBeenCalledWith(
      expect.not.objectContaining({
        isCreatedByUser: true,
      }),
    );
  });

  test('filters memory-tool boilerplate snippets from runtime recall context', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'meta_convo',
          createdAt: '2026-02-17T02:00:00.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: 'No memories found matching the search criteria.',
        },
        {
          conversationId: 'real_convo',
          createdAt: '2026-02-16T02:00:00.000Z',
          isCreatedByUser: true,
          text: 'Project Atlas investor prep included timeline planning and owner action items.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'Search memory and tell me what you remember about Project Atlas.',
      },
    });

    expect(context).toContain('conversation=real_convo');
    expect(context).not.toContain('search criteria');
  });

  test('filters assistant recall-summary chatter from runtime recall context', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'meta_convo',
          createdAt: '2026-02-17T02:00:00.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: 'Based on my search of your conversation history, I can see references to Project Atlas.',
        },
        {
          conversationId: 'real_convo',
          createdAt: '2026-02-16T02:00:00.000Z',
          isCreatedByUser: true,
          text: 'Project Atlas planning included timeline planning and owner action items.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'Remember what we discussed about Project Atlas?',
      },
    });

    expect(context).toContain('conversation=real_convo');
    expect(context).not.toContain('Based on my search of your conversation history');
  });

  test('filters internal scheduled prompts and NTA placeholders from runtime recall context', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'internal_convo',
          createdAt: '2026-02-17T02:00:00.000Z',
          isCreatedByUser: true,
          text: '<!--viv_internal:brew_begin--> ## Background Processing (Brewing) Wake. Check date, time, timezone.',
        },
        {
          conversationId: 'internal_convo',
          createdAt: '2026-02-17T02:01:00.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: '{NTA}',
        },
        {
          conversationId: 'disclaimer_convo',
          createdAt: '2026-02-17T02:01:30.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: "I don't have memory of prior chats and I can't recall your name.",
        },
        {
          conversationId: 'disclaimer_convo',
          createdAt: '2026-02-17T02:01:40.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: "I don't think you've told me that yet.",
        },
        {
          conversationId: 'real_convo',
          createdAt: '2026-02-16T02:00:00.000Z',
          isCreatedByUser: true,
          text: 'Project Atlas planning included timeline, deck narrative, and owner action items.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'What do you remember about Project Atlas planning?',
      },
    });

    expect(context).toContain('conversation=real_convo');
    expect(context).not.toContain('viv_internal');
    expect(context).not.toContain('{NTA}');
    expect(context).not.toContain("don't have memory of prior chats");
    expect(context).not.toContain("don't think you've told me that yet");
  });

  test('requires at least one high-signal term match when query contains specific entities', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'generic_convo',
          createdAt: '2026-02-17T02:00:00.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: 'I can search my memory if you want details from prior chats.',
        },
        {
          conversationId: 'generic_convo_2',
          createdAt: '2026-02-16T02:00:00.000Z',
          isCreatedByUser: true,
          text: 'Please remember this for later.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'Search your memory and tell me everything about Project Atlas and Avery.',
      },
    });

    expect(context).toBe('');
  });

  test('prioritizes explicit identity snippets for name-recall prompts', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'identity_convo',
          createdAt: '2026-02-10T01:00:00.000Z',
          isCreatedByUser: true,
          text: "I'm Avery and my legal name is Jordan.",
        },
        {
          conversationId: 'other_convo',
          createdAt: '2026-02-11T01:00:00.000Z',
          isCreatedByUser: false,
          sender: 'assistant',
          text: 'You are planning a move to SF in April.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'Do you remember my name?',
      },
    });

    expect(context).toContain('conversation=identity_convo');
    expect(context).toContain("I'm Avery");
  });

  test('ignores think blocks in runtime recall snippets', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'identity_convo',
          createdAt: '2026-02-10T01:00:00.000Z',
          isCreatedByUser: true,
          text: '',
          content: [
            { type: 'think', think: "Don't reveal this scratchpad thought." },
            { type: 'text', text: "I'm Avery." },
          ],
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'Do you remember my name?',
      },
    });

    expect(context).toContain("I'm Avery.");
    expect(context).not.toContain('scratchpad thought');
  });

  test('overfetches raw messages before filtering to avoid internal prompt saturation', async () => {
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_MESSAGES = '120';
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_FETCH_MULTIPLIER = '3';
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_SCAN_MESSAGES = '500';

    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    const messageQuery = queryResult([
      {
        conversationId: 'real_convo',
        createdAt: '2026-02-16T02:00:00.000Z',
        isCreatedByUser: true,
        text: 'My name is Avery.',
      },
    ]);
    mockMessageFind.mockReturnValue(messageQuery);

    const { buildConversationRecallRuntimeContext } = loadService();
    await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'Do you remember my name?',
      },
    });

    expect(messageQuery.limit).toHaveBeenCalledWith(360);
  });

  test('attempts runtime recall for non-remember phrasing about past discussion', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'prior_convo',
          createdAt: '2026-02-16T02:00:00.000Z',
          isCreatedByUser: true,
          text: 'We looked at stock prices for Tesla and Nvidia in detail.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'What stock prices did we look at?',
      },
    });

    expect(mockUserFindById).toHaveBeenCalledTimes(1);
    expect(context).toContain('conversation=prior_convo');
  });

  test('attempts runtime recall for sparse-token remember prompts', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'identity_convo',
          createdAt: '2026-02-16T02:00:00.000Z',
          isCreatedByUser: true,
        text: 'My name is Avery.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'Remember me',
      },
    });

    expect(mockUserFindById).toHaveBeenCalledTimes(1);
    expect(context).toContain('conversation=identity_convo');
  });

  test('attempts runtime recall for short natural entity identity prompts', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'joey_convo',
          createdAt: '2026-02-16T02:00:00.000Z',
          isCreatedByUser: true,
          text: 'Joey is the recruiter we spoke about for the hiring loop.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'Who is Joey?',
      },
    });

    expect(mockUserFindById).toHaveBeenCalledTimes(1);
    expect(context).toContain('conversation=joey_convo');
    expect(context).toContain('Joey is the recruiter');
  });

  test('attempts runtime recall for short live-status prompts when a specific entity is present', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'joey_convo',
          createdAt: '2026-02-16T02:00:00.000Z',
          isCreatedByUser: true,
          text: 'Joey said he would get back to us after reviewing the draft.',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: 'Any replies from Joey yet?',
      },
    });

    expect(mockUserFindById).toHaveBeenCalledTimes(1);
    expect(context).toContain('conversation=joey_convo');
    expect(context).toContain('Joey said he would get back to us');
  });

  test('does not attempt runtime recall for short generic status prompts without a specific entity', async () => {
    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'convo_1',
        text: 'Any replies yet?',
      },
    });

    expect(context).toBe('');
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockMessageFind).not.toHaveBeenCalled();
  });

  test('includes assistant carryover details for personal-fact prompts in matched conversations', async () => {
    mockUserFindById.mockReturnValue(
      queryResult({
        personalization: { conversation_recall: true },
      }),
    );

    mockMessageFind.mockReturnValue(
      queryResult([
        {
          conversationId: 'wife_convo',
          createdAt: '2026-02-20T17:13:59.684Z',
          isCreatedByUser: false,
          sender: 'Viventium',
          text: "It's Morgan. You met back in May 2022.",
        },
        {
          conversationId: 'wife_convo',
          createdAt: '2026-02-20T17:12:45.048Z',
          isCreatedByUser: true,
          text: 'Who is my partner?',
        },
      ]),
    );

    const { buildConversationRecallRuntimeContext } = loadService();
    const context = await buildConversationRecallRuntimeContext({
      user: { id: 'user_1' },
      agent: { id: 'agent_1', conversation_recall_agent_only: false },
      latestMessage: {
        conversationId: 'new_convo',
        text: "Remember my partner's name?",
      },
    });

    expect(context).toContain('conversation=wife_convo');
    expect(context).toContain("It's Morgan");
  });

  describe('early termination (D4)', () => {
    test('scans all candidates when early termination is OFF (default behavior preserved)', async () => {
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_EARLY_TERMINATION = 'false';
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_MATCHES = '2';
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MIN_SCORE = '0.5';

      mockUserFindById.mockReturnValue(
        queryResult({
          personalization: { conversation_recall: true },
        }),
      );

      // Generate 20 messages — all matching the recall query about "Project Atlas"
      const messages = Array.from({ length: 20 }, (_, i) => ({
        conversationId: `convo_${i}`,
        createdAt: new Date(Date.now() - i * 3600000).toISOString(),
        isCreatedByUser: true,
        text: `Project Atlas investor deck version ${i + 1} update and action items for the pitch.`,
      }));
      mockMessageFind.mockReturnValue(queryResult(messages));

      const { buildConversationRecallRuntimeContext } = loadService();
      const context = await buildConversationRecallRuntimeContext({
        user: { id: 'user_1' },
        agent: { id: 'agent_1', conversation_recall_agent_only: false },
        latestMessage: {
          conversationId: 'new_convo',
        text: 'What do you remember about Project Atlas?',
        },
      });

      // Should still return context (full scan completed)
      expect(context).toContain('Conversation Recall Context');
      expect(context).toContain('Project Atlas');
    });

    test('terminates early when enabled and enough high-confidence matches found', async () => {
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_EARLY_TERMINATION = 'true';
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_EARLY_TERMINATION_MIN_SCORE = '1.0';
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_MATCHES = '2';
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MIN_SCORE = '0.5';

      mockUserFindById.mockReturnValue(
        queryResult({
          personalization: { conversation_recall: true },
        }),
      );

      // Generate many high-signal matching messages
      const messages = Array.from({ length: 50 }, (_, i) => ({
        conversationId: `convo_${i}`,
        createdAt: new Date(Date.now() - i * 3600000).toISOString(),
        isCreatedByUser: true,
        text: `Project Atlas AI project planning and investor pitch deck version ${i + 1} ready.`,
      }));
      mockMessageFind.mockReturnValue(queryResult(messages));

      const { buildConversationRecallRuntimeContext } = loadService();
      const context = await buildConversationRecallRuntimeContext({
        user: { id: 'user_1' },
        agent: { id: 'agent_1', conversation_recall_agent_only: false },
        latestMessage: {
          conversationId: 'new_convo',
        text: 'What do you remember about Project Atlas?',
        },
      });

      // Should still produce valid context even with early termination
      expect(context).toContain('Conversation Recall Context');
      expect(context).toContain('Project Atlas');
    });

    test('falls through to full scan when early matches do not meet confidence threshold', async () => {
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_EARLY_TERMINATION = 'true';
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_EARLY_TERMINATION_MIN_SCORE = '50.0';
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_MATCHES = '2';
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MIN_SCORE = '0.5';

      mockUserFindById.mockReturnValue(
        queryResult({
          personalization: { conversation_recall: true },
        }),
      );

      // Most messages are weak, only the last one is high quality
      const messages = [
        ...Array.from({ length: 10 }, (_, i) => ({
          conversationId: `weak_convo_${i}`,
          createdAt: new Date(Date.now() - i * 3600000).toISOString(),
          isCreatedByUser: true,
          text: `General discussion about AI and projects version ${i}.`,
        })),
        {
          conversationId: 'strong_convo',
          createdAt: new Date(Date.now() - 20 * 3600000).toISOString(),
          isCreatedByUser: true,
        text: 'Project Atlas investor pitch deck finalized with a seeded target.',
        },
      ];
      mockMessageFind.mockReturnValue(queryResult(messages));

      const { buildConversationRecallRuntimeContext } = loadService();
      const context = await buildConversationRecallRuntimeContext({
        user: { id: 'user_1' },
        agent: { id: 'agent_1', conversation_recall_agent_only: false },
        latestMessage: {
          conversationId: 'new_convo',
        text: 'What do you remember about Project Atlas?',
        },
      });

      // With threshold set impossibly high (50.0), early termination never fires —
      // full scan completes and the strong match at the end is found.
      expect(context).toContain('Project Atlas');
    });

    test('early termination quality: results match full scan for spread-out matches', async () => {
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_MATCHES = '2';
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MIN_SCORE = '0.5';

      mockUserFindById.mockReturnValue(
        queryResult({
          personalization: { conversation_recall: true },
        }),
      );

      // Matches are spread: strong at index 0 and 3, filler in between
      const messages = [
        {
          conversationId: 'match_convo_1',
          createdAt: new Date(Date.now() - 1 * 3600000).toISOString(),
          isCreatedByUser: true,
          text: 'My partner Morgan and I went to dinner last night.',
        },
        {
          conversationId: 'filler_convo_1',
          createdAt: new Date(Date.now() - 2 * 3600000).toISOString(),
          isCreatedByUser: true,
          text: 'The weather today is quite nice for a walk.',
        },
        {
          conversationId: 'filler_convo_2',
          createdAt: new Date(Date.now() - 3 * 3600000).toISOString(),
          isCreatedByUser: true,
          text: 'Working on some code refactoring this afternoon.',
        },
        {
          conversationId: 'match_convo_2',
          createdAt: new Date(Date.now() - 4 * 3600000).toISOString(),
          isCreatedByUser: true,
          text: 'Morgan is planning a surprise birthday party for me.',
        },
      ];
      mockMessageFind.mockReturnValue(queryResult(messages));

      // Full scan (ET off)
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_EARLY_TERMINATION = 'false';
      const { buildConversationRecallRuntimeContext: buildFull } = loadService();
      const fullContext = await buildFull({
        user: { id: 'user_1' },
        agent: { id: 'agent_1', conversation_recall_agent_only: false },
        latestMessage: { conversationId: 'new_convo', text: "Who is my partner Morgan?" },
      });

      // Both Morgan messages should be found
      expect(fullContext).toContain('Morgan');
      expect(fullContext).toContain('conversation=match_convo_1');
    });
  });

  describe('scope cache (C)', () => {
    test('caches resolveRuntimeScope result and avoids repeated DB calls', async () => {
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_SCOPE_CACHE_TTL_MS = '60000';

      mockUserFindById.mockReturnValue(
        queryResult({
          personalization: { conversation_recall: true },
        }),
      );

      mockMessageFind.mockReturnValue(
        queryResult([
          {
            conversationId: 'prior_convo',
            createdAt: '2026-02-18T01:00:00.000Z',
            isCreatedByUser: true,
            text: 'My name is Avery.',
          },
        ]),
      );

      const { buildConversationRecallRuntimeContext, __internal } = loadService();

      // First call — should hit DB
      await buildConversationRecallRuntimeContext({
        user: { id: 'user_cache_test' },
        agent: { id: 'agent_1', conversation_recall_agent_only: false },
        latestMessage: { conversationId: 'new_convo', text: "What's my name?" },
      });
      expect(mockUserFindById).toHaveBeenCalledTimes(1);

      // Second call with same user — should use cache, no additional DB call
      await buildConversationRecallRuntimeContext({
        user: { id: 'user_cache_test' },
        agent: { id: 'agent_1', conversation_recall_agent_only: false },
        latestMessage: { conversationId: 'new_convo_2', text: "Who is my partner?" },
      });
      expect(mockUserFindById).toHaveBeenCalledTimes(1); // Still 1 — cache hit
    });

    test('cache expires after TTL and re-queries DB', async () => {
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_SCOPE_CACHE_TTL_MS = '1'; // 1ms TTL

      mockUserFindById.mockReturnValue(
        queryResult({
          personalization: { conversation_recall: true },
        }),
      );

      mockMessageFind.mockReturnValue(
        queryResult([
          {
            conversationId: 'prior_convo',
            createdAt: '2026-02-18T01:00:00.000Z',
            isCreatedByUser: true,
            text: 'My name is Avery.',
          },
        ]),
      );

      const { buildConversationRecallRuntimeContext, __internal } = loadService();

      // First call
      await buildConversationRecallRuntimeContext({
        user: { id: 'user_ttl_test' },
        agent: { id: 'agent_1', conversation_recall_agent_only: false },
        latestMessage: { conversationId: 'new_convo', text: "What's my name?" },
      });
      expect(mockUserFindById).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second call — cache expired, should query DB again
      await buildConversationRecallRuntimeContext({
        user: { id: 'user_ttl_test' },
        agent: { id: 'agent_1', conversation_recall_agent_only: false },
        latestMessage: { conversationId: 'new_convo_2', text: "Who is my wife?" },
      });
      expect(mockUserFindById).toHaveBeenCalledTimes(2); // Cache expired, re-queried
    });

    test('agent-scoped override bypasses cache entirely', async () => {
      process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_SCOPE_CACHE_TTL_MS = '60000';

      mockConversationFind.mockReturnValue(queryResult([{ conversationId: 'agent_convo_1' }]));
      mockMessageFind.mockReturnValue(
        queryResult([
          {
            conversationId: 'agent_convo_1',
            createdAt: '2026-02-18T04:00:00.000Z',
            isCreatedByUser: true,
            text: 'Project Atlas project discussion with agent-scoped recall.',
          },
        ]),
      );

      const { buildConversationRecallRuntimeContext } = loadService();
      await buildConversationRecallRuntimeContext({
        user: { id: 'user_agent_scope' },
        agent: { id: 'agent_42', conversation_recall_agent_only: true },
        latestMessage: { conversationId: 'new_convo', text: 'Remember Project Atlas?' },
      });

      // Agent-scoped override returns immediately — no User.findById call needed
      expect(mockUserFindById).not.toHaveBeenCalled();
    });
  });
});
