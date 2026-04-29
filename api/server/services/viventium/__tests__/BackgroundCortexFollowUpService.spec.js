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

  test('keeps {NTA} suppressed for non-replacement follow-ups', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'Nothing new.' }],
      },
      replaceParentMessage: false,
    });

    expect(result.text).toBe('');
    expect(result.decision.llmResult).toBe('nta');
    expect(result.decision.suppressionReason).not.toBe('');
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
