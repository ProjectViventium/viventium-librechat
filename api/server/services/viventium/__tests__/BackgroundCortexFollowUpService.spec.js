/* === VIVENTIUM START ===
 * Feature: Phase B follow-up formatting parity tests
 *
 * Purpose:
 * - Keep web follow-ups aligned with the main web reply formatting contract.
 * - Prevent follow-up prompt regressions that flatten structured web text into dense prose.
 *
 * Added: 2026-03-06
 * === VIVENTIUM END === */

const {
  formatFollowUpPrompt,
  resolveFollowUpContinuationContext,
  resolveFollowUpPersistenceText,
  sanitizeAnthropicFollowUpLLMConfig,
} = require('../BackgroundCortexFollowUpService');

describe('formatFollowUpPrompt', () => {
  test('defaults web follow-ups to markdown-friendly web text rules', () => {
    const prompt = formatFollowUpPrompt({
      insights: [{ cortexName: 'planner', insight: 'Use bullets.\n\nKeep sections tight.' }],
      recentResponse: 'Initial reply already covered the high-level recommendation.',
      voiceMode: false,
      surface: '',
    });

    expect(prompt).toContain('WEB TEXT MODE:');
    expect(prompt).toContain('Use standard Markdown formatting');
    expect(prompt).toContain('Prefer short paragraphs and bullet lists');
    expect(prompt).toContain('preserve helpful structure');
  });

  test('keeps playground follow-ups plain text', () => {
    const prompt = formatFollowUpPrompt({
      insights: [{ cortexName: 'planner', insight: 'Keep it simple.' }],
      recentResponse: 'Initial reply already covered the basics.',
      voiceMode: false,
      surface: 'playground',
    });

    expect(prompt).toContain('PLAYGROUND TEXT MODE:');
    expect(prompt).not.toContain('WEB TEXT MODE:');
  });

  test('tells the follow-up model to keep new facts even when an insight ends with a question', () => {
    const prompt = formatFollowUpPrompt({
      insights: [
        {
          cortexName: 'Pattern Recognition',
          insight:
            'Earlier today you already decided the on-site visit is optional for the reporting launch. Is the deployment still blocked?',
        },
      ],
      recentResponse: "Alright, I'm listening.",
      voiceMode: false,
      surface: '',
    });

    expect(prompt).toContain(
      'If an insight contains new factual/contextual material followed by a question, keep the new material and drop the question.',
    );
    expect(prompt).toContain(
      'Use {NTA} only when there is truly no new user-visible content beyond a question or repetition.',
    );
    expect(prompt).toContain(
      'If an insight includes a question, drop the question and keep any accompanying factual material.',
    );
    expect(prompt).not.toContain(
      'If a question seems needed, output {NTA} instead.',
    );
  });

  test('makes the main-agent continuation the adjudicator for background evidence', () => {
    const prompt = formatFollowUpPrompt({
      insights: [{ cortexName: 'worker', insight: 'The local worker finished and found a useful result.' }],
      recentResponse: 'I started the worker.',
      voiceMode: false,
      surface: '',
    });

    expect(prompt).toContain('You are the main AI continuing the same conversation.');
    expect(prompt).toContain('Background agents provide evidence only. You decide whether there is anything worth surfacing.');
    expect(prompt).toContain('respond with {NTA}');
  });

  test('shows the follow-up model newer conversation context when the thread moved on', () => {
    const prompt = formatFollowUpPrompt({
      insights: [{ cortexName: 'worker', insight: 'The venue doors opened at 8 PM.' }],
      recentResponse: "You're not late.",
      continuationContext: 'User: I am already getting ready now.\nAssistant: You have time.',
      voiceMode: false,
      surface: '',
    });

    expect(prompt).toContain('Here is the earlier response this follow-up belongs to');
    expect(prompt).toContain('## Current Conversation State');
    expect(prompt).toContain('User: I am already getting ready now.');
    expect(prompt).toContain('If the background insights are stale, redundant, already resolved');
    expect(prompt).toContain('Only surface information that is still useful now');
    expect(prompt).toContain('{NTA}');
  });

  test('makes primary deferred answers user-visible only through the main-agent continuation', () => {
    const prompt = formatFollowUpPrompt({
      insights: [{ cortexName: 'worker', insight: 'The task completed successfully.' }],
      recentResponse: 'I’m checking.',
      voiceMode: false,
      surface: '',
      primaryResponseMode: true,
    });

    expect(prompt).toContain('You are generating the primary user-visible answer for this turn.');
    expect(prompt).toContain('Background agents provide evidence only. You decide what, if anything, should become visible to the user.');
    expect(prompt).toContain('Do not output {NTA} if the insights contain any substantive user-visible information.');
  });
});

describe('resolveFollowUpPersistenceText', () => {
  test('uses deterministic fallback text when LLM follow-up is empty but substantive insights exist', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [
          {
            cortexName: 'Pattern Recognition',
            insight:
              'Earlier today you already decided the on-site visit is optional for the reporting launch and more of a morale trip.',
          },
        ],
      },
      replaceParentMessage: false,
      voiceMode: false,
      surface: 'web',
      scheduleId: '',
    });

    expect(result.text).toContain('Earlier today you already decided');
    expect(result.decision.selectedStrategy).toBe('deterministic_fallback');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('keeps {NTA} suppressed for ordinary follow-ups', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' }],
      },
      replaceParentMessage: false,
    });

    expect(result.text).toBe('');
    expect(result.decision.llmResult).toBe('nta');
    expect(result.decision.selectedStrategy).toBe('no_response_suppressed');
    expect(result.decision.suppressionReason).toBe('no_response_tag');
  });

  test('does not treat legacy replaceParentMessage input as permission to edit or force Phase B', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' }],
      },
      replaceParentMessage: true,
    });

    expect(result.text).toBe('');
    expect(result.decision.replaceParentMessage).toBe(false);
    expect(result.decision.forceVisibleFollowUp).toBe(false);
    expect(result.decision.selectedStrategy).toBe('no_response_suppressed');
  });

  test('keeps voice-mode {NTA} suppressed for ordinary follow-ups', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' }],
      },
      replaceParentMessage: false,
      voiceMode: true,
      surface: 'playground',
    });

    expect(result.text).toBe('');
    expect(result.decision.llmResult).toBe('nta');
    expect(result.decision.selectedStrategy).toBe('no_response_suppressed');
    expect(result.decision.suppressionReason).toBe('no_response_tag');
  });

  test('preserves voice-mode generated follow-up text for ordinary follow-ups', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: 'That still works.',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' }],
      },
      replaceParentMessage: false,
      voiceMode: true,
      surface: 'playground',
    });

    expect(result.text).toBe('That still works.');
    expect(result.decision.selectedStrategy).toBe('llm_generated');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('preserves forced follow-up fallback when {NTA} has visible insight text', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' }],
      },
      forceVisibleFollowUp: true,
    });

    expect(result.text).toBe('That choice is fine. Good call.');
    expect(result.decision.llmResult).toBe('nta');
    expect(result.decision.selectedStrategy).toBe('deterministic_fallback');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('forces scheduled {NTA} parent into a new visible Phase B follow-up when multiple insights exist', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [
          {
            cortexName: 'Background Analysis',
            insight: 'I reviewed the latest context and found one open work loop that can wait.',
          },
          {
            cortexName: 'MS365',
            insight: 'I found 2 calendar items that need attention today.',
            completed_tool_calls: 2,
          },
        ],
      },
      forceVisibleFollowUp: true,
      scheduleId: 'schedule_123',
    });

    expect(result.text).toBe('I found 2 calendar items that need attention today.');
    expect(result.decision.llmResult).toBe('nta');
    expect(result.decision.selectedStrategy).toBe('best_visible_insight');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('preserves voice-mode forced follow-up fallback when generated follow-up text is empty', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' }],
      },
      forceVisibleFollowUp: true,
      voiceMode: true,
      surface: 'playground',
    });

    expect(result.text).toBe('That choice is fine. Good call.');
    expect(result.decision.selectedStrategy).toBe('deterministic_fallback');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('keeps voice-mode empty follow-up generation silent instead of speaking raw insights', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' }],
      },
      replaceParentMessage: false,
      voiceMode: true,
      surface: 'playground',
    });

    expect(result.text).toBe('');
    expect(result.decision.selectedStrategy).toBe('voice_empty_suppressed');
    expect(result.decision.suppressionReason).toBe('empty_voice_followup');
  });

  test('keeps moved-on empty follow-up generation silent on all surfaces', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'Old context that may be stale.' }],
      },
      replaceParentMessage: false,
      voiceMode: false,
      surface: 'web',
      movedOnAfterParent: true,
    });

    expect(result.text).toBe('');
    expect(result.decision.selectedStrategy).toBe('moved_on_empty_suppressed');
    expect(result.decision.suppressionReason).toBe('moved_on_empty_followup');
  });

  test('keeps moved-on empty Telegram follow-up generation silent', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'Old context that may be stale.' }],
      },
      replaceParentMessage: false,
      voiceMode: false,
      surface: 'telegram',
      movedOnAfterParent: true,
    });

    expect(result.text).toBe('');
    expect(result.decision.selectedStrategy).toBe('moved_on_empty_suppressed');
    expect(result.decision.suppressionReason).toBe('moved_on_empty_followup');
  });

  test('keeps moved-on generated follow-up text when the main agent finds it useful', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: 'One useful new detail: doors are already open.',
      insightsData: {
        insights: [{ cortexName: 'Deep Research', insight: 'Doors opened at 8 PM.' }],
      },
      replaceParentMessage: false,
      voiceMode: false,
      surface: 'web',
      movedOnAfterParent: true,
    });

    expect(result.text).toBe('One useful new detail: doors are already open.');
    expect(result.decision.selectedStrategy).toBe('llm_generated');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('preserves forced follow-up fallback even when conversation moved on', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [{ cortexName: 'worker', insight: 'The task completed successfully.' }],
      },
      forceVisibleFollowUp: true,
      voiceMode: false,
      surface: 'web',
      movedOnAfterParent: true,
    });

    expect(result.text).toBe('The task completed successfully.');
    expect(result.decision.selectedStrategy).toBe('deterministic_fallback');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('labels voice-mode empty suppression caused by follow-up generation failure', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' }],
      },
      replaceParentMessage: false,
      voiceMode: true,
      surface: 'playground',
      generationFailed: true,
    });

    expect(result.text).toBe('');
    expect(result.decision.selectedStrategy).toBe('voice_empty_suppressed');
    expect(result.decision.suppressionReason).toBe('voice_followup_generation_failed');
    expect(result.decision.generationFailed).toBe(true);
  });
});

describe('resolveFollowUpContinuationContext', () => {
  test('builds current conversation context from newer user and assistant descendants', () => {
    const result = resolveFollowUpContinuationContext(
      [
        {
          messageId: 'assistant-a',
          parentMessageId: 'user-a',
          sender: 'AI',
          text: "You're not late.",
          createdAt: '2026-05-03T03:04:20.000Z',
        },
        {
          messageId: 'user-b',
          parentMessageId: 'assistant-a',
          sender: 'User',
          isCreatedByUser: true,
          text: 'I am already getting ready now.',
          createdAt: '2026-05-03T03:04:30.000Z',
        },
        {
          messageId: 'assistant-b',
          parentMessageId: 'user-b',
          sender: 'AI',
          text: 'You have time.',
          createdAt: '2026-05-03T03:04:35.000Z',
        },
      ],
      'assistant-a',
    );

    expect(result.hasMovedOn).toBe(true);
    expect(result.currentLeafMessageId).toBe('assistant-b');
    expect(result.contextText).toContain('User: I am already getting ready now.');
    expect(result.contextText).toContain('Assistant: You have time.');
  });

  test('does not mark assistant-only descendants as moved on', () => {
    const result = resolveFollowUpContinuationContext(
      [
        { messageId: 'assistant-a', parentMessageId: 'user-a', sender: 'AI', text: 'Checking.' },
        {
          messageId: 'assistant-child',
          parentMessageId: 'assistant-a',
          sender: 'AI',
          text: 'Background card updated.',
        },
      ],
      'assistant-a',
    );

    expect(result.hasMovedOn).toBe(false);
    expect(result.contextText).toBe('');
  });

  test('finds a user continuation through a two-hop descendant path', () => {
    const result = resolveFollowUpContinuationContext(
      [
        { messageId: 'assistant-a', parentMessageId: 'user-a', sender: 'AI', text: 'First.' },
        {
          messageId: 'assistant-child',
          parentMessageId: 'assistant-a',
          sender: 'AI',
          text: 'Interim assistant message.',
        },
        {
          messageId: 'user-c',
          parentMessageId: 'assistant-child',
          sender: 'User',
          isCreatedByUser: true,
          text: 'Actually I already handled that.',
        },
      ],
      'assistant-a',
    );

    expect(result.hasMovedOn).toBe(true);
    expect(result.currentLeafMessageId).toBe('user-c');
    expect(result.contextText).toContain('Actually I already handled that.');
  });

  test('does not pull sibling-branch text when current leaf is not downstream of parent', () => {
    const result = resolveFollowUpContinuationContext(
      [
        { messageId: 'assistant-a', parentMessageId: 'user-a', sender: 'AI', text: 'Branch A.' },
        {
          messageId: 'user-b',
          parentMessageId: 'user-a',
          sender: 'User',
          isCreatedByUser: true,
          text: 'Sibling branch user text.',
          createdAt: '2026-05-03T03:04:30.000Z',
        },
        {
          messageId: 'assistant-b',
          parentMessageId: 'user-b',
          sender: 'AI',
          text: 'Sibling branch answer.',
          createdAt: '2026-05-03T03:04:35.000Z',
        },
      ],
      'assistant-a',
    );

    expect(result.hasMovedOn).toBe(false);
    expect(result.contextText).toBe('');
    expect(result.currentLeafMessageId).toBe('assistant-b');
  });
});

describe('sanitizeAnthropicFollowUpLLMConfig', () => {
  test('removes temperature when Anthropic follow-up relies on default thinking', () => {
    const result = sanitizeAnthropicFollowUpLLMConfig({
      model: 'claude-sonnet-4-6',
      temperature: 0.3,
    });

    expect(result.temperature).toBeUndefined();
  });

  test('removes temperature for Anthropic adaptive-capable models even when thinking is explicitly disabled', () => {
    const result = sanitizeAnthropicFollowUpLLMConfig({
      model: 'claude-sonnet-4-6',
      temperature: 0.3,
      thinking: false,
    });

    expect(result.temperature).toBeUndefined();
  });

  test('preserves temperature for legacy Anthropic models when thinking is explicitly disabled', () => {
    const result = sanitizeAnthropicFollowUpLLMConfig({
      model: 'claude-sonnet-4-5-20250929',
      temperature: 0.3,
      thinking: false,
    });

    expect(result.temperature).toBe(0.3);
  });
});
