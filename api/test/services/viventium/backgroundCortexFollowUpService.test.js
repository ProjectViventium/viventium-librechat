/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

/* === VIVENTIUM NOTE ===
 * Purpose: Viventium integration module (background cortex/voice/telegram).
 * Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#librechat-viventium-additions
 * === VIVENTIUM NOTE === */

const { EModelEndpoint } = require('librechat-data-provider');

jest.mock('@librechat/agents', () => ({
  Run: {
    create: jest.fn(async () => ({
      processStream: jest.fn(async () => 'llm-followup'),
    })),
  },
  Providers: {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
  },
}));

jest.mock('@librechat/api', () => ({
  initializeAnthropic: jest.fn(async ({ model_parameters }) => ({
    llmConfig: {
      model: model_parameters?.model ?? 'claude-sonnet-4-5',
      temperature: model_parameters?.temperature ?? 0.7,
      maxTokens: model_parameters?.max_output_tokens ?? 400,
      anthropicApiUrl: 'https://anthropic-proxy.example.test',
    },
  })),
  initializeOpenAI: jest.fn(async ({ model_parameters }) => ({
    llmConfig: {
      model: model_parameters?.model ?? 'gpt-5.4',
      temperature: model_parameters?.temperature ?? 0.7,
      maxTokens: model_parameters?.max_output_tokens ?? 400,
      useResponsesApi: true,
      configuration: {
        apiKey: 'oauth-user-key',
        baseURL: 'https://chatgpt.com/backend-api/codex',
        defaultHeaders: {
          'OpenAI-Beta': 'responses=experimental',
          'chatgpt-account-id': 'acct_123',
        },
      },
    },
  })),
}));

jest.mock('~/server/services/BackgroundCortexService', () => ({
  getCustomEndpointConfig: jest.fn(async () => null),
  mapProvider: jest.fn(() => 'openai'),
}));

jest.mock('~/models', () => ({
  getMessage: jest.fn(),
  getMessages: jest.fn(),
  updateMessage: jest.fn(),
  saveMessage: jest.fn(),
}));

jest.mock('~/models/Agent', () => ({
  getAgent: jest.fn(),
}));

const db = require('~/models');
const { getAgent } = require('~/models/Agent');
const { initializeAnthropic, initializeOpenAI } = require('@librechat/api');
const { Run } = require('@librechat/agents');
const {
  cleanFallbackInsightText,
  getVisibleFallbackInsightTexts,
  isOperationalFallbackParagraph,
  upsertCortexParts,
  persistCortexPartsToCanonicalMessage,
  finalizeCanonicalCortexMessage,
  createCortexFollowUpMessage,
  generateFollowUpText,
  formatFollowUpText,
  deduplicateInsights,
  formatFollowUpPrompt,
  extractRecentResponseTextFromMessage,
  getPreferredFallbackInsightText,
  resolveRecentResponseText,
  resolveConversationLeafMessageId,
  stripQuestionSentences,
} = require('~/server/services/viventium/BackgroundCortexFollowUpService');

describe('BackgroundCortexFollowUpService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAgent.mockResolvedValue(null);
  });

  describe('recent response resolution', () => {
    test('extractRecentResponseTextFromMessage prefers top-level text', () => {
      const text = extractRecentResponseTextFromMessage({
        text: 'Top level',
        content: [{ type: 'text', text: 'Content level' }],
      });
      expect(text).toBe('Top level');
    });

    test('extractRecentResponseTextFromMessage falls back to content text part', () => {
      const text = extractRecentResponseTextFromMessage({
        text: '',
        content: [{ type: 'text', text: 'Content level' }],
      });
      expect(text).toBe('Content level');
    });

    test('resolveRecentResponseText uses in-memory recentResponse when provided', async () => {
      const resolved = await resolveRecentResponseText({
        req: { user: { id: 'u1' } },
        parentMessageId: 'm-parent',
        recentResponse: 'In memory',
      });
      expect(resolved).toEqual({ text: 'In memory', source: 'in_memory_content_parts' });
      expect(db.getMessage).not.toHaveBeenCalled();
    });

    test('resolveRecentResponseText falls back to DB parent message content', async () => {
      db.getMessage.mockResolvedValueOnce({
        messageId: 'm-parent',
        text: '',
        content: [{ type: 'text', text: 'Phase A from DB content' }],
      });

      const resolved = await resolveRecentResponseText({
        req: { user: { id: 'u1' } },
        parentMessageId: 'm-parent',
        recentResponse: '',
      });

      expect(db.getMessage).toHaveBeenCalledWith({ user: 'u1', messageId: 'm-parent' });
      expect(resolved).toEqual({ text: 'Phase A from DB content', source: 'db_parent_message' });
    });
  });

  describe('question stripping', () => {
    test('removes pure question sentence', () => {
      expect(stripQuestionSentences('What should we do next?')).toBe('');
    });

    test('keeps declarative sentence when question is a separate sentence', () => {
      expect(stripQuestionSentences('I found one missing detail. What should we do?')).toBe(
        'I found one missing detail.',
      );
    });

    test('salvages declarative prefix before comma-separated question clause', () => {
      expect(stripQuestionSentences('New detail X found, shall we dig deeper?')).toBe(
        'New detail X found.',
      );
    });

    test('salvages declarative prefix when comma has no trailing space', () => {
      expect(stripQuestionSentences('New detail X found,shall we dig deeper?')).toBe(
        'New detail X found.',
      );
    });

    test('salvages declarative prefix before em-dash question clause', () => {
      expect(stripQuestionSentences('The data shows improvement— isn\'t that great?')).toBe(
        'The data shows improvement.',
      );
    });

    test('salvages declarative prefix when em-dash has no trailing space', () => {
      expect(stripQuestionSentences('The data shows improvement—isn\'t that great?')).toBe(
        'The data shows improvement.',
      );
    });

    test('handles mixed declarative and question sentences together', () => {
      expect(stripQuestionSentences('Found a pattern. Also X is interesting, right?')).toBe(
        'Found a pattern. Also X is interesting.',
      );
    });

    test('returns text unchanged when no question marks present', () => {
      expect(stripQuestionSentences('Everything looks good here.')).toBe(
        'Everything looks good here.',
      );
    });
  });

  test('upsertCortexParts replaces existing cortex part by cortex_id', () => {
    const existing = [
      { type: 'text', text: 'hello' },
      { type: 'cortex_brewing', cortex_id: 'c1', status: 'brewing' },
    ];
    const next = [
      { type: 'cortex_insight', cortex_id: 'c1', status: 'complete', insight: 'done' },
    ];

    const merged = upsertCortexParts(existing, next);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual(expect.objectContaining({ cortex_id: 'c1', status: 'complete' }));
  });

  test('persistCortexPartsToCanonicalMessage updates message content when message exists', async () => {
    const req = { user: { id: 'u1' } };
    db.getMessage.mockResolvedValue({ messageId: 'm1', content: [{ type: 'text', text: 'hi' }] });
    db.updateMessage.mockResolvedValue({ messageId: 'm1' });

    const updated = await persistCortexPartsToCanonicalMessage({
      req,
      responseMessageId: 'm1',
      cortexParts: [{ type: 'cortex_brewing', cortex_id: 'c1', status: 'brewing' }],
      maxAttempts: 1,
    });

    expect(db.getMessage).toHaveBeenCalledWith({ user: 'u1', messageId: 'm1' });
    expect(db.updateMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ messageId: 'm1', content: expect.any(Array) }),
      expect.any(Object),
    );
    expect(updated).toEqual(
      expect.arrayContaining([expect.objectContaining({ cortex_id: 'c1', status: 'brewing' })]),
    );
  });

  test('finalizeCanonicalCortexMessage marks the canonical parent as finished', async () => {
    const req = { user: { id: 'u1' } };
    db.getMessage.mockResolvedValue({ messageId: 'm1', unfinished: true, text: 'Phase A' });
    db.updateMessage.mockResolvedValue({ messageId: 'm1' });

    const finalized = await finalizeCanonicalCortexMessage({
      req,
      messageId: 'm1',
    });

    expect(db.updateMessage).toHaveBeenCalledWith(
      req,
      { messageId: 'm1', unfinished: false },
      expect.any(Object),
    );
    expect(finalized).toEqual(expect.objectContaining({ messageId: 'm1', unfinished: false }));
  });

  test('formatFollowUpText prefers insights list when available', () => {
    const text = formatFollowUpText({
      insights: [{ cortexName: 'Background Analysis', insight: 'Secret code: 27' }],
      mergedPrompt: 'ignored',
      hasErrors: false,
    });
    expect(text).not.toContain('Background insights');
    expect(text).not.toContain('Background Analysis');
    expect(text).toContain('Secret code: 27');
  });

  test('formatFollowUpText returns user-safe line on error-only', () => {
    const text = formatFollowUpText({
      insights: [],
      mergedPrompt: 'ignored',
      hasErrors: true,
    });
    expect(text).toBe("I couldn't finish that check just now.");
    expect(text).not.toContain('Background insights');
  });

  test('cleanFallbackInsightText strips operational scheduler paragraphs', () => {
    const text = cleanFallbackInsightText(
      'Tuesday 7PM Toronto. Evening reset.\n\nRepeated "Wake" prompts across 20+ turns today, hitting tool auth walls each time.',
    );
    expect(text).toBe('Tuesday 7PM Toronto. Evening reset.');
  });

  test('cleanFallbackInsightText strips reconnect and auth-expiry chatter', () => {
    const text = cleanFallbackInsightText(
      'Taylor Reed sent the project onboarding invite for April 1 at 10 AM Pacific.\n\nGoogle auth is stale, so Gmail could not be verified tonight without reconnect.',
    );
    expect(text).toBe('Taylor Reed sent the project onboarding invite for April 1 at 10 AM Pacific.');
  });

  test('cleanFallbackInsightText strips generic no-access live tool chatter', () => {
    const text = cleanFallbackInsightText(
      'It is Thursday night in Toronto.\n\nI checked what I could live here, but I do not have working Google/MS calendar, inbox, or schedule tools available in this run to verify anything important there.\n\nTomorrow still looks manageable.',
    );
    expect(text).toBe('It is Thursday night in Toronto.\n\nTomorrow still looks manageable.');
  });

  test('cleanFallbackInsightText strips live-check and unauthenticated availability chatter', () => {
    const text = cleanFallbackInsightText(
      'Fri Mar 27, 2026, 2:03 AM UTC — weekday; I couldn’t live-check Outlook inbox/calendar or Gmail in this run.\n\nOutlook inbox/calendar unavailable here, and Gmail appears unauthenticated.',
    );
    expect(text).toBe('');
  });

  test('isOperationalFallbackParagraph detects tool-availability failure text', () => {
    expect(
      isOperationalFallbackParagraph(
        'Could not perform the requested live checks because no MS365/Google tools are available in this chat.',
      ),
    ).toBe(true);
  });

  test('getVisibleFallbackInsightTexts suppresses multi-insight scheduler fallback dumps', () => {
    const texts = getVisibleFallbackInsightTexts({
      insightTexts: ['First visible insight', 'Second visible insight'],
      scheduleId: 'schedule-1',
    });
    expect(texts).toEqual([]);
  });

  test('formatFollowUpText returns the single cleaned scheduler insight', () => {
    const text = formatFollowUpText({
      insights: [
        {
          insight:
            'Could not perform the requested live checks because no MS365/Google tools are available in this chat, and I won’t invent inbox/calendar results.{NTA}',
        },
        { insight: 'Tuesday 9PM Toronto. Day crushed, tomorrow Steven/Raff blocks locked.' },
      ],
      hasErrors: false,
      scheduleId: 'schedule-1',
    });
    expect(text).toBe('Tuesday 9PM Toronto. Day crushed, tomorrow Steven/Raff blocks locked.');
  });

  test('formatFollowUpText skips empty insight strings', () => {
    const text = formatFollowUpText({
      insights: [{ insight: '  ' }, { insight: 'Kept: file is attached.' }],
      hasErrors: false,
    });
    expect(text).toBe('Kept: file is attached.');
  });

  test('getPreferredFallbackInsightText prioritizes tool and research cortices for deferred fallback', () => {
    const text = getPreferredFallbackInsightText({
      insights: [
        {
          cortexName: 'Confirmation Bias',
          insight:
            'A lawyer might be overselling one criterion here, but this is still just a high-level caution.',
        },
        {
          cortexName: 'Google',
          insight:
            'I read the doc. Short version: the profile is more plausibly O-1A than O-1B if the achievements are framed around business impact and measurable recognition.',
        },
        {
          cortexName: 'Deep Research',
          insight:
            'For a 2026 O-1 assessment, the decisive questions are sustained acclaim, judging/critical role evidence, and whether counsel overstated weak criteria.',
        },
      ],
      allowMultiInsightBestEffort: true,
    });

    expect(text).toBe(
      'I read the doc. Short version: the profile is more plausibly O-1A than O-1B if the achievements are framed around business impact and measurable recognition.',
    );
  });

  test('getPreferredFallbackInsightText allows scheduler deferred best-effort fallback to pick one cleaned insight', () => {
    const text = getPreferredFallbackInsightText({
      insights: [
        {
          cortexName: 'Background Analysis',
          insight:
            'Thursday night in Toronto. The continuity thread is alive, but there are a few stale signals from last week mixed in.',
        },
        {
          cortexName: 'MS365',
          insight:
            'Taylor Reed sent the project onboarding invite for April 1 at 10 AM Pacific. The application thread is moving.',
        },
        {
          cortexName: 'Google',
          insight:
            'I checked what I could live here. Google auth is stale, so I could not verify Gmail tonight without reconnect.',
        },
      ],
      scheduleId: 'schedule-1',
      allowMultiInsightBestEffort: true,
    });

    expect(text).toBe(
      'Taylor Reed sent the project onboarding invite for April 1 at 10 AM Pacific. The application thread is moving.',
    );
  });

  test('getPreferredFallbackInsightText prefers concrete live result over longer no-access scheduler chatter', () => {
    const text = getPreferredFallbackInsightText({
      insights: [
        {
          cortexName: 'Background Analysis',
          insight:
            'Thursday, 9 PM in Toronto. End of the work week push.\n\nMemory has a gap from mid-March, so continuity is imperfect tonight.',
        },
        {
          cortexName: 'MS365',
          insight:
            'It’s Thursday night in Toronto — late enough for companion mode, not push mode.\n\nA couple unread Outlook threads look real, not noise: one from David about user-login/cost questions, and one on Raffaele with an attachment. Tomorrow starts with a 10:00am partner strategy connect, then founder standup at 3:00pm.',
        },
        {
          cortexName: 'Google',
          insight:
            'It’s Thursday night, 9:04 PM in Toronto — EDT, weekday energy, so light touch.\n\nI checked what I could live here, but I don’t have working Google/MS calendar, inbox, or schedule tools available in this run to verify anything important there.\n\nNow: nothing live is telling me there’s an urgent fire.',
        },
      ],
      scheduleId: 'schedule-1',
      allowMultiInsightBestEffort: true,
    });

    expect(text).toBe(
      'It’s Thursday night in Toronto — late enough for companion mode, not push mode.\n\nA couple unread Outlook threads look real, not noise: one from David about user-login/cost questions, and one on Raffaele with an attachment. Tomorrow starts with a 10:00am partner strategy connect, then founder standup at 3:00pm.',
    );
  });

  test('getPreferredFallbackInsightText does not depend on cortex naming when structured tool evidence exists', () => {
    const text = getPreferredFallbackInsightText({
      insights: [
        {
          cortexName: 'MS365',
          configured_tools: 2,
          completed_tool_calls: 0,
          insight:
            'I can’t verify Outlook in this run, so this is only a soft intuition about the inbox.',
        },
        {
          cortexName: 'Pattern Recognition',
          configured_tools: 2,
          completed_tool_calls: 3,
          insight:
            'I checked the inbox live: one unread Microsoft DMARC aggregate report arrived today at 10:52 AM UTC.',
        },
      ],
      scheduleId: 'schedule-1',
      allowMultiInsightBestEffort: true,
    });

    expect(text).toBe(
      'I checked the inbox live: one unread Microsoft DMARC aggregate report arrived today at 10:52 AM UTC.',
    );
  });

  test('getPreferredFallbackInsightText suppresses access-limitation-only scheduler insights', () => {
    const text = getPreferredFallbackInsightText({
      insights: [
        {
          cortexName: 'MS365',
          insight:
            'Fri, Mar 27, 2026, 2:04 AM UTC — weekday; Outlook/Gmail live check unavailable in this run, so I can only confirm date/time/timezone/day type.',
        },
        {
          cortexName: 'Google',
          insight:
            'Fri Mar 27, 2026, 2:04 AM UTC — weekday; Gmail/Outlook inbox and calendar aren’t available in this run, so I can’t check them live.',
        },
      ],
      scheduleId: 'schedule-1',
      allowMultiInsightBestEffort: true,
    });

    expect(text).toBe('');
  });

  test('formatFollowUpText returns empty string when no insights and no errors', () => {
    const text = formatFollowUpText({
      insights: [],
      mergedPrompt: '',
      hasErrors: false,
    });
    expect(text).toBe('');
  });

  test('createCortexFollowUpMessage saves a follow-up message with metadata', async () => {
    const req = { user: { id: 'u1' } };
    db.saveMessage.mockResolvedValue({});

    const msg = await createCortexFollowUpMessage({
      req,
      conversationId: 'c-123',
      parentMessageId: 'm-parent',
      agent: { id: 'agent_123' },
      insightsData: {
        cortexCount: 1,
        insights: [{ cortexName: 'Background Analysis', insight: 'Secret code: 27' }],
      },
    });

    expect(msg).toBeTruthy();
    expect(db.saveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        conversationId: 'c-123',
        parentMessageId: 'm-parent',
        isCreatedByUser: false,
        agent_id: 'agent_123',
        metadata: expect.objectContaining({
          viventium: expect.objectContaining({ type: 'cortex_followup' }),
        }),
      }),
      expect.any(Object),
    );
  });

  test('resolveConversationLeafMessageId prefers the actual leaf over the last-written ancestor row', () => {
    const leafMessageId = resolveConversationLeafMessageId([
      {
        messageId: 'assistant-phase-1',
        parentMessageId: 'user-message',
        createdAt: '2026-03-26T19:41:38.221Z',
        updatedAt: '2026-03-26T19:41:42.938Z',
      },
      {
        messageId: 'user-message',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-26T19:41:38.348Z',
        updatedAt: '2026-03-26T19:41:42.940Z',
      },
    ]);

    expect(leafMessageId).toBe('assistant-phase-1');
  });

  test('createCortexFollowUpMessage attaches non-deferred follow-up to the current leaf message', async () => {
    const req = { user: { id: 'u1' } };
    db.saveMessage.mockResolvedValue({});
    db.getMessages.mockResolvedValueOnce([
      {
        messageId: 'assistant-phase-1',
        parentMessageId: 'user-message',
        createdAt: '2026-03-26T19:41:38.221Z',
        updatedAt: '2026-03-26T19:41:42.938Z',
      },
      {
        messageId: 'user-message',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-26T19:41:38.348Z',
        updatedAt: '2026-03-26T19:41:42.940Z',
      },
    ]);

    const msg = await createCortexFollowUpMessage({
      req,
      conversationId: 'c-123',
      parentMessageId: 'assistant-phase-1',
      agent: { id: 'agent_123' },
      insightsData: {
        cortexCount: 1,
        insights: [{ cortexName: 'Background Analysis', insight: 'Secret code: 27' }],
      },
    });

    expect(msg).toBeTruthy();
    expect(db.saveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        conversationId: 'c-123',
        parentMessageId: 'assistant-phase-1',
      }),
      expect.any(Object),
    );
  });

  test('createCortexFollowUpMessage returns null when there is nothing to say', async () => {
    const req = { user: { id: 'u1' } };
    const msg = await createCortexFollowUpMessage({
      req,
      conversationId: 'c-123',
      parentMessageId: 'm-parent',
      agent: { id: 'agent_123' },
      insightsData: { insights: [], mergedPrompt: '', hasErrors: false },
    });
    expect(msg).toBeNull();
    expect(db.saveMessage).not.toHaveBeenCalled();
  });

  test('createCortexFollowUpMessage suppresses question-only follow-up as {NTA}', async () => {
    const req = { user: { id: 'u1' } };
    db.getMessage.mockResolvedValueOnce({
      messageId: 'm-parent',
      text: '',
      content: [{ type: 'text', text: 'Phase A response from DB' }],
    });
    db.getMessages.mockResolvedValueOnce([{ messageId: 'm-parent' }]);

    Run.create.mockResolvedValueOnce({
      processStream: jest.fn(async () => 'Should I ask another question?'),
    });

    const msg = await createCortexFollowUpMessage({
      req,
      conversationId: 'c-123',
      parentMessageId: 'm-parent',
      agent: { id: 'agent_123', provider: 'openai', model: 'gpt-4o-mini', model_parameters: {} },
      insightsData: {
        insights: [{ cortexName: 'Background Analysis', insight: 'Duplicate question-style hint' }],
      },
      recentResponse: '',
    });

    expect(msg).toBeNull();
    expect(db.getMessage).toHaveBeenCalledWith({ user: 'u1', messageId: 'm-parent' });
    expect(db.saveMessage).not.toHaveBeenCalled();
  });

  test('createCortexFollowUpMessage injects DB Phase A text into follow-up prompt', async () => {
    const req = { user: { id: 'u1' } };
    db.getMessage.mockResolvedValueOnce({
      messageId: 'm-parent',
      text: '',
      content: [{ type: 'text', text: 'Phase A response from DB content parts' }],
    });
    db.getMessages.mockResolvedValueOnce([{ messageId: 'm-parent' }]);
    db.saveMessage.mockResolvedValueOnce({});

    let capturedPrompt = '';
    Run.create.mockResolvedValueOnce({
      processStream: jest.fn(async ({ messages }) => {
        capturedPrompt = messages[0].content;
        return 'One new missing detail.';
      }),
    });

    const msg = await createCortexFollowUpMessage({
      req,
      conversationId: 'c-123',
      parentMessageId: 'm-parent',
      agent: { id: 'agent_123', provider: 'openai', model: 'gpt-4o-mini', model_parameters: {} },
      insightsData: {
        insights: [{ cortexName: 'Background Analysis', insight: 'One additional detail' }],
      },
      recentResponse: '',
    });

    expect(capturedPrompt).toContain('Phase A response from DB content parts');
    expect(msg).toBeTruthy();
    expect(msg.text).toBe('One new missing detail.');
  });

  test('createCortexFollowUpMessage replaces deferred parent message in place', async () => {
    const req = { user: { id: 'u1' } };
    db.getMessage.mockResolvedValue({
      messageId: 'm-parent',
      parentMessageId: 'u-message',
      sender: 'Viventium',
      text: 'Checking now.',
      content: [
        { type: 'text', text: 'Checking now.' },
        {
          type: 'cortex_insight',
          cortex_id: 'agent_123',
          status: 'complete',
          insight: 'Fresh tool result',
        },
      ],
      metadata: {
        viventium: {
          existing: true,
        },
      },
    });
    db.updateMessage.mockResolvedValue({});

    Run.create.mockResolvedValueOnce({
      processStream: jest.fn(async () => 'Final resolved answer'),
    });

    const msg = await createCortexFollowUpMessage({
      req,
      conversationId: 'c-123',
      parentMessageId: 'm-parent',
      agent: { id: 'agent_123', provider: 'openai', model: 'gpt-5.4', model_parameters: {} },
      insightsData: {
        cortexCount: 1,
        insights: [{ cortexName: 'MS365', insight: 'Fresh tool result' }],
      },
      recentResponse: '',
      replaceParentMessage: true,
    });

    expect(db.updateMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        messageId: 'm-parent',
        text: 'Final resolved answer',
        unfinished: false,
        content: [
          { type: 'text', text: 'Final resolved answer' },
          expect.objectContaining({
            type: 'cortex_insight',
            cortex_id: 'agent_123',
          }),
        ],
      }),
      expect.any(Object),
    );
    expect(db.saveMessage).not.toHaveBeenCalled();
    expect(msg).toEqual(
      expect.objectContaining({
        messageId: 'm-parent',
        parentMessageId: 'u-message',
        text: 'Final resolved answer',
        unfinished: false,
      }),
    );
  });

  test('createCortexFollowUpMessage replaces deferred parent with best insight when follow-up synthesis returns NTA', async () => {
    const req = { user: { id: 'u1' } };
    db.getMessage.mockResolvedValue({
      messageId: 'm-parent',
      parentMessageId: 'u-message',
      sender: 'Viventium',
      text: 'Checking now.',
      unfinished: true,
      content: [
        { type: 'text', text: 'Checking now.' },
        {
          type: 'cortex_insight',
          cortex_id: 'google-1',
          status: 'complete',
          insight:
            'I read the doc. Short version: the profile is more plausibly O-1A than O-1B if the achievements are framed around business impact and measurable recognition.',
        },
        {
          type: 'cortex_insight',
          cortex_id: 'research-1',
          status: 'complete',
          insight:
            'For a 2026 O-1 assessment, the decisive questions are sustained acclaim, judging/critical role evidence, and whether counsel overstated weak criteria.',
        },
      ],
      metadata: {
        viventium: {
          existing: true,
        },
      },
    });
    db.updateMessage.mockResolvedValue({});

    Run.create.mockResolvedValueOnce({
      processStream: jest.fn(async () => '{NTA}'),
    });

    const msg = await createCortexFollowUpMessage({
      req,
      conversationId: 'c-123',
      parentMessageId: 'm-parent',
      agent: { id: 'agent_123', provider: 'openai', model: 'gpt-5.4', model_parameters: {} },
      insightsData: {
        cortexCount: 2,
        insights: [
          {
            cortexName: 'Google',
            insight:
              'I read the doc. Short version: the profile is more plausibly O-1A than O-1B if the achievements are framed around business impact and measurable recognition.',
          },
          {
            cortexName: 'Deep Research',
            insight:
              'For a 2026 O-1 assessment, the decisive questions are sustained acclaim, judging/critical role evidence, and whether counsel overstated weak criteria.',
          },
        ],
      },
      recentResponse: '',
      replaceParentMessage: true,
    });

    expect(db.updateMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        messageId: 'm-parent',
        text:
          'I read the doc. Short version: the profile is more plausibly O-1A than O-1B if the achievements are framed around business impact and measurable recognition.',
        unfinished: false,
      }),
      expect.any(Object),
    );
    expect(msg).toEqual(
      expect.objectContaining({
        messageId: 'm-parent',
        text:
          'I read the doc. Short version: the profile is more plausibly O-1A than O-1B if the achievements are framed around business impact and measurable recognition.',
        unfinished: false,
      }),
    );
  });

  test('createCortexFollowUpMessage replaces deferred scheduler parent with best insight when synthesis fails', async () => {
    const req = { user: { id: 'u1' }, body: { scheduleId: 'schedule-1' } };
    db.getMessage.mockResolvedValue({
      messageId: 'm-parent',
      parentMessageId: 'u-message',
      sender: 'Viventium',
      text: '',
      unfinished: true,
      content: [
        { type: 'text', text: '' },
        {
          type: 'cortex_insight',
          cortex_id: 'ms365-1',
          status: 'complete',
          insight:
            'Taylor Reed sent the project onboarding invite for April 1 at 10 AM Pacific. The application thread is moving.',
        },
        {
          type: 'cortex_insight',
          cortex_id: 'google-1',
          status: 'complete',
          insight:
            'I checked what I could live here. Google auth is stale, so I could not verify Gmail tonight without reconnect.',
        },
      ],
      metadata: {
        viventium: {
          existing: true,
        },
      },
    });
    db.updateMessage.mockResolvedValue({});

    Run.create.mockResolvedValueOnce({
      processStream: jest.fn(async () => {
        throw new Error('temperature is not supported when thinking is enabled');
      }),
    });

    const msg = await createCortexFollowUpMessage({
      req,
      conversationId: 'c-123',
      parentMessageId: 'm-parent',
      agent: { id: 'agent_123', provider: 'openai', model: 'gpt-5.4', model_parameters: {} },
      insightsData: {
        cortexCount: 2,
        insights: [
          {
            cortexName: 'MS365',
            insight:
              'Taylor Reed sent the project onboarding invite for April 1 at 10 AM Pacific. The application thread is moving.',
          },
          {
            cortexName: 'Google',
            insight:
              'I checked what I could live here. Google auth is stale, so I could not verify Gmail tonight without reconnect.',
          },
        ],
        hasErrors: true,
      },
      recentResponse: '',
      replaceParentMessage: true,
    });

    expect(db.updateMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        messageId: 'm-parent',
        text: 'Taylor Reed sent the project onboarding invite for April 1 at 10 AM Pacific. The application thread is moving.',
        unfinished: false,
      }),
      expect.any(Object),
    );
    expect(msg).toEqual(
      expect.objectContaining({
        messageId: 'm-parent',
        text: 'Taylor Reed sent the project onboarding invite for April 1 at 10 AM Pacific. The application thread is moving.',
        unfinished: false,
      }),
    );
  });

  test('createCortexFollowUpMessage suppresses scheduler deferred persistence when no visible fallback remains', async () => {
    const req = { user: { id: 'u1' }, body: { scheduleId: 'schedule-1' } };

    const msg = await createCortexFollowUpMessage({
      req,
      conversationId: 'c-123',
      parentMessageId: 'm-parent',
      agent: { id: 'agent_123' },
      insightsData: { insights: [], mergedPrompt: '', hasErrors: true },
      replaceParentMessage: true,
    });

    expect(msg).toBeNull();
    expect(db.updateMessage).not.toHaveBeenCalled();
    expect(db.saveMessage).not.toHaveBeenCalled();
  });

  test('createCortexFollowUpMessage strips leaked NTA and citation artifacts before save', async () => {
    const req = { user: { id: 'u1' } };
    db.getMessage.mockResolvedValueOnce({
      messageId: 'm-parent',
      text: '',
      content: [{ type: 'text', text: 'Phase A response from DB content parts' }],
    });
    db.getMessages.mockResolvedValueOnce([{ messageId: 'm-parent' }]);
    db.saveMessage.mockResolvedValueOnce({});

    Run.create.mockResolvedValueOnce({
      processStream: jest.fn(async () => '{NTA} Keep the good part \\ue202turn0search0 [12] here'),
    });

    const msg = await createCortexFollowUpMessage({
      req,
      conversationId: 'c-123',
      parentMessageId: 'm-parent',
      agent: { id: 'agent_123', provider: 'openai', model: 'gpt-4o-mini', model_parameters: {} },
      insightsData: {
        insights: [{ cortexName: 'Background Analysis', insight: 'One additional detail' }],
      },
      recentResponse: '',
    });

    expect(msg).toBeTruthy();
    expect(msg.text).toBe('Keep the good part here');
  });

  // === VIVENTIUM NOTE ===
  test('generateFollowUpText injects voice rules when voiceMode is true', async () => {
    const req = { user: { id: 'u1' }, body: { voiceMode: true } };
    await generateFollowUpText({
      req,
      agent: {
        id: 'agent_123',
        provider: 'openai',
        model: 'gpt-5.4',
        model_parameters: {},
        instructions: 'base',
      },
      insightsData: {
        insights: [{ cortexName: 'Background Analysis', insight: 'Secret code: 27' }],
      },
      recentResponse: 'Got it.',
      runId: 'run-1',
    });

    const runPromise = Run.create.mock.results[0].value;
    const runInstance = await runPromise;
    const callArgs = runInstance.processStream.mock.calls[0][0];
    const prompt = callArgs.messages[0].content;
    expect(prompt).toContain('VOICE FOLLOW-UP RULES');
  });
  // === VIVENTIUM NOTE ===

  test('generateFollowUpText uses primary-answer prompt and token budget for deferred mode', async () => {
    const req = { user: { id: 'u1' }, body: {} };

    await generateFollowUpText({
      req,
      agent: {
        id: 'agent_123',
        provider: 'openai',
        model: 'gpt-5.4',
        model_parameters: {},
      },
      insightsData: {
        insights: [{ cortexName: 'Google', insight: 'Doc review complete.' }],
      },
      recentResponse: 'Checking now.',
      runId: 'run-primary',
      primaryResponseMode: true,
    });

    const runPromise = Run.create.mock.results[0].value;
    const runInstance = await runPromise;
    const callArgs = runInstance.processStream.mock.calls[0][0];
    const prompt = callArgs.messages[0].content;

    expect(prompt).toContain('This is not an addendum. This is the main answer that should replace the brief hold.');
    expect(prompt).not.toContain('Only respond if the insights contain genuinely NEW information not covered above.');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          instructions: expect.stringContaining('completing a deferred response after a short holding acknowledgement'),
          llmConfig: expect.objectContaining({
            maxTokens: 2000,
          }),
        }),
      }),
    );
  });

  test('generateFollowUpText resolves OpenAI follow-up config through initializeOpenAI', async () => {
    const req = { user: { id: 'u1' }, body: {} };

    await generateFollowUpText({
      req,
      agent: {
        id: 'agent_123',
        provider: 'openai',
        model: 'gpt-5.4',
        model_parameters: { temperature: 0.2, max_output_tokens: 222 },
      },
      insightsData: {
        insights: [{ cortexName: 'MS365', insight: 'Inbox snapshot ready' }],
      },
      recentResponse: 'Checking now.',
      runId: 'run-1',
    });

    expect(initializeOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        endpoint: EModelEndpoint.openAI,
        db,
      }),
    );

    const runPromise = Run.create.mock.results[0].value;
    const runInstance = await runPromise;
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            useResponsesApi: true,
            configuration: expect.objectContaining({
              baseURL: 'https://chatgpt.com/backend-api/codex',
              defaultHeaders: expect.objectContaining({
                'OpenAI-Beta': 'responses=experimental',
                'chatgpt-account-id': 'acct_123',
              }),
            }),
          }),
        }),
      }),
    );
    expect(runInstance.processStream).toHaveBeenCalled();
  });

  test('generateFollowUpText keeps governed OpenAI fallback when agent model metadata is missing', async () => {
    const req = { user: { id: 'u1' }, body: {} };

    await generateFollowUpText({
      req,
      agent: {
        id: 'agent_123',
        provider: 'openai',
        model_parameters: {},
      },
      insightsData: {
        insights: [{ cortexName: 'Google', insight: 'Inbox review complete.' }],
      },
      recentResponse: 'Checking now.',
      runId: 'run-governed-openai-fallback',
    });

    expect(initializeOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        model_parameters: expect.objectContaining({
          model: 'gpt-5.4',
        }),
      }),
    );
    expect(Run.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            provider: 'openai',
            model: 'gpt-5.4',
          }),
        }),
      }),
    );
  });

  test('generateFollowUpText keeps governed Anthropic fallback when agent model metadata is missing', async () => {
    const req = { user: { id: 'u1' }, body: {}, config: {} };

    await generateFollowUpText({
      req,
      agent: {
        id: 'agent_123',
        provider: 'anthropic',
        model_parameters: {},
      },
      insightsData: {
        insights: [{ cortexName: 'Strategic Planning', insight: 'Roadmap check complete.' }],
      },
      recentResponse: 'Checking now.',
      runId: 'run-governed-anthropic-fallback',
    });

    expect(initializeAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        model_parameters: expect.objectContaining({
          model: 'claude-sonnet-4-6',
        }),
      }),
    );
  });

  test('generateFollowUpText rehydrates canonical runtime provider/model when follow-up agent payload dropped provider', async () => {
    const req = { user: { id: 'u1' }, body: {}, config: {} };
    const originalProvider = process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER;
    const originalModel = process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL;
    process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER = 'anthropic';
    process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL = 'claude-opus-4-7';

    try {
      await generateFollowUpText({
        req,
        agent: {
          id: 'agent_viventium_main_95aeb3',
          model_parameters: { temperature: 0.3 },
        },
        insightsData: {
          insights: [{ cortexName: 'Strategic Planning', insight: 'Roadmap check complete.' }],
        },
        recentResponse: 'Checking now.',
        runId: 'run-rehydrated-runtime-agent',
      });
    } finally {
      if (originalProvider == null) {
        delete process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER;
      } else {
        process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER = originalProvider;
      }
      if (originalModel == null) {
        delete process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL;
      } else {
        process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL = originalModel;
      }
    }

    expect(initializeAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        model_parameters: expect.objectContaining({
          model: 'claude-opus-4-7',
        }),
      }),
    );
  });

  test('generateFollowUpText treats poisoned string provider values as missing and rehydrates runtime provider/model', async () => {
    const req = { user: { id: 'u1' }, body: {}, config: {} };
    const originalProvider = process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER;
    const originalModel = process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL;
    process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER = 'anthropic';
    process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL = 'claude-opus-4-7';

    try {
      await generateFollowUpText({
        req,
        agent: {
          id: 'agent_viventium_main_95aeb3',
          provider: 'undefined',
          model_parameters: { temperature: 0.3 },
        },
        insightsData: {
          insights: [{ cortexName: 'Strategic Planning', insight: 'Condense this to one sharp line.' }],
        },
        recentResponse: 'Checking now.',
        runId: 'run-poisoned-provider',
      });
    } finally {
      if (originalProvider == null) {
        delete process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER;
      } else {
        process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER = originalProvider;
      }
      if (originalModel == null) {
        delete process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL;
      } else {
        process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL = originalModel;
      }
    }

    expect(initializeAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        model_parameters: expect.objectContaining({
          model: 'claude-opus-4-7',
        }),
      }),
    );
  });

  test('generateFollowUpText rehydrates canonical persisted agent when runtime agent lost provider/model fields', async () => {
    const req = { user: { id: 'u1' }, body: {}, config: {} };
    getAgent.mockResolvedValue({
      id: 'agent_viventium_main_95aeb3',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: { temperature: 0.2, thinking: false },
      voice_llm_provider: 'xai',
      voice_llm_model: 'grok-4-1-fast-non-reasoning',
    });

    await generateFollowUpText({
      req,
      agent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'undefined',
        model: '',
        model_parameters: { temperature: 0.3 },
      },
      insightsData: {
        insights: [{ cortexName: 'Strategic Planning', insight: 'Close revenue first.' }],
      },
      recentResponse: 'Checking now.',
      runId: 'run-canonical-agent-rehydrate',
    });

    expect(getAgent).toHaveBeenCalledWith({ id: 'agent_viventium_main_95aeb3' });
    expect(initializeAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        model_parameters: expect.objectContaining({
          model: 'claude-opus-4-7',
          temperature: 0.3,
          thinking: false,
        }),
      }),
    );
  });

  test('generateFollowUpText uses dedicated voice model parameters without overwriting the primary bag', async () => {
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';
    const req = {
      user: { id: 'u1' },
      body: {
        voiceMode: true,
        viventiumInputMode: 'voice_call',
        viventiumSurface: 'voice',
      },
      config: { endpoints: { agents: { allowedProviders: ['anthropic', 'openAI'] } } },
    };
    getAgent.mockResolvedValue({
      id: 'agent_viventium_main_95aeb3',
      provider: 'openAI',
      model: 'gpt-5.4',
      model_parameters: { reasoning_effort: 'high' },
      voice_llm_provider: 'anthropic',
      voice_llm_model: 'claude-haiku-4-5',
      voice_llm_model_parameters: { temperature: 0.1, max_output_tokens: 160 },
    });

    try {
      await generateFollowUpText({
        req,
        agent: {
          id: 'agent_viventium_main_95aeb3',
          provider: 'openAI',
          model: 'gpt-5.4',
          model_parameters: { reasoning_effort: 'high' },
          voice_llm_provider: 'anthropic',
          voice_llm_model: 'claude-haiku-4-5',
          voice_llm_model_parameters: { temperature: 0.1, max_output_tokens: 160 },
        },
        insightsData: {
          insights: [{ cortexName: 'Support', insight: 'Let them know the voice path is ready.' }],
        },
        recentResponse: 'Checking now.',
        runId: 'run-voice-followup-params',
      });

      expect(initializeAnthropic).toHaveBeenCalledWith(
        expect.objectContaining({
          model_parameters: expect.objectContaining({
            model: 'claude-haiku-4-5',
            reasoning_effort: 'high',
            temperature: 0.1,
            max_output_tokens: 400,
          }),
        }),
      );
    } finally {
      if (originalAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
      }
    }
  });

  test('generateFollowUpText restores canonical Anthropic reasoning flags even when runtime provider is already present', async () => {
    const req = { user: { id: 'u1' }, body: {}, config: {} };
    getAgent.mockResolvedValue({
      id: 'agent_viventium_main_95aeb3',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: { thinking: false },
    });

    await generateFollowUpText({
      req,
      agent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        model_parameters: {},
      },
      insightsData: {
        insights: [{ cortexName: 'Strategic Planning', insight: 'Keep the synthesis short.' }],
      },
      recentResponse: 'Checking now.',
      runId: 'run-canonical-anthropic-flags',
    });

    expect(initializeAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        model_parameters: expect.objectContaining({
          model: 'claude-opus-4-7',
          thinking: false,
        }),
      }),
    );
  });

  test('generateFollowUpText resolves Anthropic follow-up config through initializeAnthropic', async () => {
    const req = { user: { id: 'u1' }, body: {}, config: {} };

    await generateFollowUpText({
      req,
      agent: {
        id: 'agent_123',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        model_parameters: { temperature: 0.1, max_output_tokens: 144 },
      },
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'Evening reset is real.' }],
      },
      recentResponse: 'Checking now.',
      runId: 'run-2',
    });

    expect(initializeAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        endpoint: EModelEndpoint.anthropic,
        db,
      }),
    );

    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            provider: 'anthropic',
            anthropicApiUrl: 'https://anthropic-proxy.example.test',
          }),
        }),
      }),
    );
    expect(Run.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            provider: 'anthropic',
            model: 'claude-opus-4-7',
          }),
        }),
      }),
    );
  });

  test('generateFollowUpText strips Anthropic temperature when thinking is active in the final llm config', async () => {
    const req = { user: { id: 'u1' }, body: {}, config: {} };
    initializeAnthropic.mockResolvedValueOnce({
      llmConfig: {
        model: 'claude-opus-4-7',
        temperature: 0.7,
        maxTokens: 400,
        thinking: { type: 'adaptive' },
        anthropicApiUrl: 'https://anthropic-proxy.example.test',
      },
    });

    await generateFollowUpText({
      req,
      agent: {
        id: 'agent_123',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        model_parameters: {},
      },
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'One line only.' }],
      },
      recentResponse: 'Checking now.',
      runId: 'run-anthropic-thinking-temp',
    });

    const runCall = Run.create.mock.calls[Run.create.mock.calls.length - 1][0];
    expect(runCall.graphConfig.llmConfig.provider).toBe('anthropic');
    expect(runCall.graphConfig.llmConfig.model).toBe('claude-opus-4-7');
    expect(runCall.graphConfig.llmConfig.thinking).toEqual({ type: 'adaptive' });
    expect(runCall.graphConfig.llmConfig.temperature).toBeUndefined();
  });

  // === VIVENTIUM NOTE ===
  // Tests for anti-repetition follow-up prompt fix (2026-02-24)

  describe('deduplicateInsights', () => {
    test('returns single insight unchanged', () => {
      const insights = [{ cortexName: 'A', insight: 'Pancakes are done' }];
      expect(deduplicateInsights(insights)).toEqual(insights);
    });

    test('returns empty/falsy input unchanged', () => {
      expect(deduplicateInsights([])).toEqual([]);
      expect(deduplicateInsights(null)).toEqual(null);
      expect(deduplicateInsights(undefined)).toEqual(undefined);
    });

    test('removes duplicate insights with >50% word overlap', () => {
      const insights = [
        { cortexName: 'Strategic Planning', insight: 'Pancakes are stacked and ready for first bite verdict from Taylor' },
        { cortexName: 'Background Analysis', insight: 'Pancakes stacked ready - check the first bite from Taylor verdict' },
        { cortexName: 'Continuity', insight: 'Completely different topic about the philosophy draft' },
      ];
      const deduped = deduplicateInsights(insights);
      expect(deduped).toHaveLength(2);
      expect(deduped[0].cortexName).toBe('Strategic Planning');
      expect(deduped[1].cortexName).toBe('Continuity');
    });

    test('keeps insights with <50% overlap', () => {
      const insights = [
        { cortexName: 'A', insight: 'The morning schedule has three meetings today' },
        { cortexName: 'B', insight: 'Taylor mentioned the roadmap draft needs review' },
      ];
      const deduped = deduplicateInsights(insights);
      expect(deduped).toHaveLength(2);
    });

    test('handles insights with empty text gracefully', () => {
      const insights = [
        { cortexName: 'A', insight: '' },
        { cortexName: 'B', insight: 'Real insight here' },
      ];
      const deduped = deduplicateInsights(insights);
      expect(deduped).toHaveLength(2);
    });
  });

  describe('formatFollowUpPrompt (anti-repetition)', () => {
    test('includes CRITICAL Do Not Repeat header', () => {
      const prompt = formatFollowUpPrompt({
        insights: [{ cortexName: 'Test', insight: 'Some insight' }],
        recentResponse: 'I already said this.',
      });
      expect(prompt).toContain('## CRITICAL: Do Not Repeat');
    });

    test('includes recent response text in the prompt', () => {
      const prompt = formatFollowUpPrompt({
        insights: [{ cortexName: 'Test', insight: 'Some insight' }],
        recentResponse: 'Pancakes are ready and stacked high!',
      });
      expect(prompt).toContain('Pancakes are ready and stacked high!');
      expect(prompt).toContain('JUST sent to the user');
    });

    test('instructs NTA when redundant', () => {
      const prompt = formatFollowUpPrompt({
        insights: [{ cortexName: 'Test', insight: 'Some insight' }],
        recentResponse: 'Some response.',
      });
      expect(prompt).toContain('{NTA}');
      expect(prompt).toContain('redundant or already covered');
    });

    test('returns empty string for no insights', () => {
      const prompt = formatFollowUpPrompt({
        insights: [],
        recentResponse: 'Some response.',
      });
      expect(prompt).toBe('');
    });

    test('uses deferred-primary wording when primaryResponseMode is true', () => {
      const prompt = formatFollowUpPrompt({
        insights: [{ cortexName: 'Google', insight: 'Detailed analysis ready.' }],
        recentResponse: 'Checking now.',
        primaryResponseMode: true,
      });

      expect(prompt).toContain('This is not an addendum. This is the main answer that should replace the brief hold.');
      expect(prompt).toContain('Do not output {NTA} if the insights contain any substantive user-visible information.');
      expect(prompt).not.toContain('## CRITICAL: Do Not Repeat');
    });

    test('does not contain old weak instruction', () => {
      const prompt = formatFollowUpPrompt({
        insights: [{ cortexName: 'Test', insight: 'Some insight' }],
        recentResponse: 'Test.',
      });
      expect(prompt).not.toContain('Additional background insights surfaced after your last response');
    });

    test('handles missing recentResponse gracefully', () => {
      const prompt = formatFollowUpPrompt({
        insights: [{ cortexName: 'Test', insight: 'Some insight' }],
      });
      expect(prompt).toContain('(short acknowledgment)');
      expect(prompt).toContain('## CRITICAL: Do Not Repeat');
    });
  });

  test('generateFollowUpText uses minimal system prompt without agent personality', async () => {
    const req = { user: { id: 'u1' }, body: {} };
    await generateFollowUpText({
      req,
      agent: { id: 'agent_123', instructions: 'You are Eve, a deeply personal companion AI.', provider: 'openai' },
      insightsData: {
        insights: [{ cortexName: 'Background Analysis', insight: 'New finding' }],
      },
      recentResponse: 'Got it.',
      runId: 'run-1',
    });

    const runConfig = Run.create.mock.calls[0][0];
    const systemPrompt = runConfig.graphConfig.instructions;
    expect(systemPrompt).not.toContain('Eve');
    expect(systemPrompt).not.toContain('deeply personal');
    expect(systemPrompt).toContain('conversational AI assistant');
    expect(systemPrompt).toContain('{NTA}');
  });
  // === VIVENTIUM NOTE ===
});
