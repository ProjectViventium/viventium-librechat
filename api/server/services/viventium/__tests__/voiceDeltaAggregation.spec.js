const { ContentTypes } = require('librechat-data-provider');
const {
  collapseRecoveredVisibleTextDuplicate,
  createMessageDeltaBoundaryNormalizer,
  extractVisibleTextFromContentParts,
  repairMissedVisibleMessageDelta,
  repairMissedVoiceMessageDelta,
} = require('../voiceDeltaAggregation');
const { projectVisibleTextFromContentParts } = require('../ViventiumVisibleContentProjection');

describe('voiceDeltaAggregation', () => {
  test('normalizes cumulative snapshots at the message-delta event boundary', () => {
    const normalize = createMessageDeltaBoundaryNormalizer({ deltaMode: 'snapshot' });
    const emitted = [];

    for (const text of ['I', 'I hear', 'I hear you.']) {
      const result = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
      });
      emitted.push(result.data.delta.content[0].text);
    }

    expect(emitted).toEqual(['I', ' hear', ' you.']);
    expect(emitted.join('')).toBe('I hear you.');
  });

  test('normalizes mid-word cumulative snapshots when the adapter declares snapshot mode', () => {
    const normalize = createMessageDeltaBoundaryNormalizer({ deltaMode: 'snapshot' });
    const emitted = [];

    for (const text of ['Hel', 'Hello', 'Hello world']) {
      const result = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
      });
      emitted.push(result.data.delta.content[0].text);
    }

    expect(emitted).toEqual(['Hel', 'lo', ' world']);
    expect(emitted.join('')).toBe('Hello world');
  });

  test('normalizes cumulative no-response snapshots without malformed recombination', () => {
    const normalize = createMessageDeltaBoundaryNormalizer({ deltaMode: 'snapshot' });
    const emitted = [];

    for (const text of ['{N', '{NTA', '{NTA}']) {
      const result = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
      });
      emitted.push(result.data.delta.content[0].text);
    }

    expect(emitted).toEqual(['{N', 'TA', '}']);
    expect(emitted.join('')).toBe('{NTA}');
  });

  test.each([
    ['a', 'and'],
    ['ha', 'hahaha'],
    ['I', 'Item'],
  ])('preserves ambiguous incremental prefixes by default: %s + %s', (first, second) => {
    const normalize = createMessageDeltaBoundaryNormalizer();
    const emitted = [first, second].map((text) =>
      normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
      }),
    );

    expect(emitted.map((result) => result.data.delta.content[0].text)).toEqual([first, second]);
    expect(emitted.map((result) => result.data.delta.content[0].text).join('')).toBe(
      `${first}${second}`,
    );
  });

  test('leaves events unchanged when explicitly configured for incremental deltas', () => {
    const normalize = createMessageDeltaBoundaryNormalizer({ deltaMode: 'incremental' });
    const result = normalize({
      event: 'on_message_delta',
      data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text: 'I hear' }] } },
    });

    expect(result.normalized).toBe(false);
    expect(result.data.delta.content[0].text).toBe('I hear');
  });

  test('repairs an emitted voice delta when upstream aggregation did not advance text', () => {
    const contentParts = [];

    const repaired = repairMissedVoiceMessageDelta({
      contentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'I hear you.' }] } },
      beforeText: '',
      afterText: '',
    });

    expect(repaired).toBe(true);
    expect(contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'I hear you.' }]);
    expect(extractVisibleTextFromContentParts(contentParts)).toBe('I hear you.');
  });

  test('repairs an emitted visible delta for non-voice surfaces when aggregation did not advance', () => {
    const contentParts = [];

    const repaired = repairMissedVisibleMessageDelta({
      contentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'Already visible answer.' }] } },
      beforeText: '',
      afterText: '',
    });

    expect(repaired).toBe(true);
    expect(contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'Already visible answer.' }]);
    expect(extractVisibleTextFromContentParts(contentParts)).toBe('Already visible answer.');
  });

  test('marks an ownerless first visible delta so final pruning cannot discard it', () => {
    const contentParts = [{ type: ContentTypes.TEXT, text: 'Already visible answer.' }];

    const repaired = repairMissedVisibleMessageDelta({
      contentParts,
      beforeContentParts: [],
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'Already visible answer.' }] } },
      beforeText: '',
      afterText: 'Already visible answer.',
      contentMeta: { unownedVisible: true },
    });

    expect(repaired).toBe(true);
    expect(contentParts).toEqual([
      {
        type: ContentTypes.TEXT,
        text: 'Already visible answer.',
        viventiumUnownedVisible: true,
      },
    ]);
  });

  test('reclaims an early ownerless fragment when the same run step later gains an owner', () => {
    const contentParts = [];
    const firstMeta = {
      unownedVisible: true,
      sourceStepId: 'step-late-owner',
    };

    expect(
      repairMissedVisibleMessageDelta({
        contentParts,
        beforeContentParts: [],
        event: 'on_message_delta',
        data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'Yes' }] } },
        beforeText: '',
        afterText: '',
        contentMeta: firstMeta,
      }),
    ).toBe(true);

    const beforeSecond = contentParts.map((part) => ({ ...part }));
    expect(
      repairMissedVisibleMessageDelta({
        contentParts,
        beforeContentParts: beforeSecond,
        event: 'on_message_delta',
        data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'terday at 6pm.' }] } },
        beforeText: 'Yes',
        afterText: 'Yes',
        contentMeta: {
          agentId: 'agent-main',
          groupId: 1,
          sourceStepId: 'step-late-owner',
        },
      }),
    ).toBe(true);

    expect(contentParts).toEqual([
      {
        type: ContentTypes.TEXT,
        text: 'Yesterday at 6pm.',
        agentId: 'agent-main',
        groupId: 1,
        viventiumSourceStepId: 'step-late-owner',
      },
    ]);
  });

  test('reclaims a single-stream ownerless prefix when the run-step owner arrives mid-word', () => {
    const contentParts = [];

    repairMissedVoiceMessageDelta({
      contentParts,
      beforeContentParts: [],
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'V' }] } },
      beforeText: '',
      afterText: '',
      contentMeta: { agentId: null, groupId: null },
    });

    const beforeSecond = contentParts.map((part) => ({ ...part }));
    contentParts.push({
      type: ContentTypes.TEXT,
      text: 'IVENTIUM VOICE LIVE PASS',
      agentId: 'agent-main',
    });
    repairMissedVoiceMessageDelta({
      contentParts,
      beforeContentParts: beforeSecond,
      event: 'on_message_delta',
      data: {
        delta: { content: [{ type: ContentTypes.TEXT, text: 'IVENTIUM VOICE LIVE PASS' }] },
      },
      beforeText: 'V',
      afterText: 'VIVENTIUM VOICE LIVE PASS',
      contentMeta: { agentId: 'agent-main', groupId: null },
    });

    expect(contentParts).toEqual([
      {
        type: ContentTypes.TEXT,
        text: 'VIVENTIUM VOICE LIVE PASS',
        agentId: 'agent-main',
      },
    ]);
    expect(projectVisibleTextFromContentParts(contentParts, { trim: true })).toBe(
      'VIVENTIUM VOICE LIVE PASS',
    );
  });

  test('keeps a split no-response marker contiguous when its owner arrives late', () => {
    const contentParts = [];
    repairMissedVisibleMessageDelta({
      contentParts,
      beforeContentParts: [],
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: '{NT' }] } },
      beforeText: '',
      afterText: '',
      contentMeta: {
        unownedVisible: true,
        sourceStepId: 'step-nta',
      },
    });

    repairMissedVisibleMessageDelta({
      contentParts,
      beforeContentParts: contentParts.map((part) => ({ ...part })),
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'A}' }] } },
      beforeText: '{NT',
      afterText: '{NT',
      contentMeta: {
        agentId: 'agent-main',
        groupId: 1,
        sourceStepId: 'step-nta',
      },
    });

    expect(extractVisibleTextFromContentParts(contentParts)).toBe('{NTA}');
    expect(contentParts).toHaveLength(1);
  });

  test('coalesces interleaved early fragments by source step before their owners arrive', () => {
    const contentParts = [];
    const appendEarly = (text, sourceStepId) =>
      repairMissedVisibleMessageDelta({
        contentParts,
        beforeContentParts: contentParts.map((part) => ({ ...part })),
        event: 'on_message_delta',
        data: { delta: { content: [{ type: ContentTypes.TEXT, text }] } },
        beforeText: extractVisibleTextFromContentParts(contentParts),
        afterText: extractVisibleTextFromContentParts(contentParts),
        contentMeta: { unownedVisible: true, sourceStepId },
      });

    expect(appendEarly('Yes', 'step-a')).toBe(true);
    expect(appendEarly('Second participant here.', 'step-b')).toBe(true);
    expect(appendEarly('terday at 6pm.', 'step-a')).toBe(true);

    expect(contentParts).toEqual([
      {
        type: ContentTypes.TEXT,
        text: 'Yesterday at 6pm.',
        viventiumSourceStepId: 'step-a',
        viventiumUnownedVisible: true,
      },
      {
        type: ContentTypes.TEXT,
        text: 'Second participant here.',
        viventiumSourceStepId: 'step-b',
        viventiumUnownedVisible: true,
      },
    ]);
  });

  test('keeps an interleaved early no-response marker contiguous by source step', () => {
    const contentParts = [];
    const appendEarly = (text, sourceStepId) =>
      repairMissedVisibleMessageDelta({
        contentParts,
        beforeContentParts: contentParts.map((part) => ({ ...part })),
        event: 'on_message_delta',
        data: { delta: { content: [{ type: ContentTypes.TEXT, text }] } },
        beforeText: extractVisibleTextFromContentParts(contentParts),
        afterText: extractVisibleTextFromContentParts(contentParts),
        contentMeta: { unownedVisible: true, sourceStepId },
      });

    appendEarly('{NT', 'step-nta');
    appendEarly('Second participant here.', 'step-b');
    appendEarly('A}', 'step-nta');

    expect(contentParts[0]).toEqual({
      type: ContentTypes.TEXT,
      text: '{NTA}',
      viventiumSourceStepId: 'step-nta',
      viventiumUnownedVisible: true,
    });
  });

  test('keeps distinct Main invocation steps separate even when agent and group match', () => {
    const beforeContentParts = [
      {
        type: ContentTypes.TEXT,
        text: 'Pre-handoff.',
        agentId: 'agent-main',
        groupId: 1,
      },
    ];
    const contentParts = beforeContentParts.map((part) => ({ ...part }));

    expect(
      repairMissedVisibleMessageDelta({
        contentParts,
        beforeContentParts,
        event: 'on_message_delta',
        data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'Post-handoff.' }] } },
        beforeText: 'Pre-handoff.',
        afterText: 'Pre-handoff.',
        contentMeta: {
          agentId: 'agent-main',
          groupId: 1,
          sourceStepId: 'step-post-handoff',
        },
      }),
    ).toBe(true);

    expect(contentParts).toEqual([
      beforeContentParts[0],
      {
        type: ContentTypes.TEXT,
        text: 'Post-handoff.',
        agentId: 'agent-main',
        groupId: 1,
        viventiumSourceStepId: 'step-post-handoff',
      },
    ]);
  });

  test('pins the source step on an owned delta that upstream aggregated correctly', () => {
    const beforeContentParts = [];
    const contentParts = [
      {
        type: ContentTypes.TEXT,
        text: 'First invocation.',
        agentId: 'agent-main',
        groupId: 1,
      },
    ];

    expect(
      repairMissedVisibleMessageDelta({
        contentParts,
        beforeContentParts,
        event: 'on_message_delta',
        data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'First invocation.' }] } },
        beforeText: '',
        afterText: 'First invocation.',
        contentMeta: {
          agentId: 'agent-main',
          groupId: 1,
          sourceStepId: 'step-first-invocation',
        },
      }),
    ).toBe(false);

    expect(contentParts[0]).toEqual(
      expect.objectContaining({ viventiumSourceStepId: 'step-first-invocation' }),
    );
  });

  test('moves a new-step delta out of an older pinned step for the same agent and group', () => {
    const beforeContentParts = [
      {
        type: ContentTypes.TEXT,
        text: 'before',
        agentId: 'agent-main',
        groupId: 1,
        viventiumSourceStepId: 'step-old',
      },
    ];
    const contentParts = [
      {
        ...beforeContentParts[0],
        text: 'beforeafter',
      },
    ];

    expect(
      repairMissedVisibleMessageDelta({
        contentParts,
        beforeContentParts,
        event: 'on_message_delta',
        data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'after' }] } },
        beforeText: 'before',
        afterText: 'beforeafter',
        contentMeta: {
          agentId: 'agent-main',
          groupId: 1,
          sourceStepId: 'step-new',
        },
      }),
    ).toBe(true);
    expect(contentParts).toEqual([
      beforeContentParts[0],
      {
        type: ContentTypes.TEXT,
        text: 'after',
        agentId: 'agent-main',
        groupId: 1,
        viventiumSourceStepId: 'step-new',
      },
    ]);
  });

  test.each([
    ['VOICE', ' DELTA QA'],
    ['VOICE ', 'DELTA QA'],
    ['micro', 'scope'],
  ])(
    'coalesces adjacent fragments from the same owned run step byte-for-byte: %j + %j',
    (firstFragment, secondFragment) => {
      const beforeContentParts = [
        {
          type: ContentTypes.TEXT,
          text: firstFragment,
          agentId: 'agent-main',
          viventiumSourceStepId: 'step-voice-reply',
        },
      ];
      const contentParts = [
        ...beforeContentParts.map((part) => ({ ...part })),
        {
          type: ContentTypes.TEXT,
          text: secondFragment,
          agentId: 'agent-main',
          viventiumSourceStepId: 'step-voice-reply',
        },
      ];

      expect(
        repairMissedVoiceMessageDelta({
          contentParts,
          beforeContentParts,
          event: 'on_message_delta',
          data: { delta: { content: [{ type: ContentTypes.TEXT, text: secondFragment }] } },
          beforeText: firstFragment,
          afterText: `${firstFragment}${secondFragment}`,
          contentMeta: {
            agentId: 'agent-main',
            groupId: null,
            sourceStepId: 'step-voice-reply',
          },
        }),
      ).toBe(true);

      expect(contentParts).toEqual([
        {
          type: ContentTypes.TEXT,
          text: `${firstFragment}${secondFragment}`,
          agentId: 'agent-main',
          viventiumSourceStepId: 'step-voice-reply',
        },
      ]);
    },
  );

  /* === VIVENTIUM START ===
   * Regression: MC-045 must exercise the exact-advance branch with realistic interleaving.
   */
  test('pins real-shaped interleaved A/B/A deltas when upstream advances each target exactly', () => {
    const contentParts = [];
    const advanceExactly = ({ agentId, sourceStepId, deltaText }) => {
      const beforeContentParts = contentParts.map((part) => ({ ...part }));
      const existingIndex = contentParts.findIndex((part) => part.agentId === agentId);
      if (existingIndex >= 0) {
        contentParts[existingIndex] = {
          ...contentParts[existingIndex],
          text: `${contentParts[existingIndex].text}${deltaText}`,
        };
      } else {
        contentParts.push({
          type: ContentTypes.TEXT,
          text: deltaText,
          agentId,
          groupId: 1,
        });
      }

      return repairMissedVisibleMessageDelta({
        contentParts,
        beforeContentParts,
        event: 'on_message_delta',
        data: { delta: { content: [{ type: ContentTypes.TEXT, text: deltaText }] } },
        beforeText: extractVisibleTextFromContentParts(beforeContentParts),
        afterText: extractVisibleTextFromContentParts(contentParts),
        contentMeta: { agentId, groupId: 1, sourceStepId },
      });
    };

    expect(
      advanceExactly({
        agentId: 'agent-primary',
        sourceStepId: 'step-a',
        deltaText: 'Primary starts. ',
      }),
    ).toBe(false);
    expect(
      advanceExactly({
        agentId: 'agent-primary____1',
        sourceStepId: 'step-b',
        deltaText: 'Parallel answer.',
      }),
    ).toBe(false);
    expect(
      advanceExactly({
        agentId: 'agent-primary',
        sourceStepId: 'step-a',
        deltaText: 'Primary finishes.',
      }),
    ).toBe(false);

    expect(contentParts).toEqual([
      {
        type: ContentTypes.TEXT,
        text: 'Primary starts. Primary finishes.',
        agentId: 'agent-primary',
        groupId: 1,
        viventiumSourceStepId: 'step-a',
      },
      {
        type: ContentTypes.TEXT,
        text: 'Parallel answer.',
        agentId: 'agent-primary____1',
        groupId: 1,
        viventiumSourceStepId: 'step-b',
      },
    ]);
  });
  /* === VIVENTIUM END === */

  test('keeps missed parallel-agent deltas in separate structured content parts', () => {
    const contentParts = [
      {
        type: ContentTypes.TEXT,
        text: 'Base answer.',
        agentId: 'agent-main',
        groupId: 1,
      },
    ];

    const repaired = repairMissedVisibleMessageDelta({
      contentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'Added answer.' }] } },
      beforeText: 'Base answer.',
      afterText: 'Base answer.',
      contentMeta: { agentId: 'agent-main____1', groupId: 1 },
    });

    expect(repaired).toBe(true);
    expect(contentParts).toEqual([
      expect.objectContaining({
        text: 'Base answer.',
        agentId: 'agent-main',
        groupId: 1,
      }),
      expect.objectContaining({
        text: 'Added answer.',
        agentId: 'agent-main____1',
        groupId: 1,
      }),
    ]);
  });

  test('repairs a parallel delta that the upstream aggregator appended to another agent part', () => {
    const beforeContentParts = [
      {
        type: ContentTypes.TEXT,
        text: 'Base answer.',
        agentId: 'agent-main',
        groupId: 1,
      },
    ];
    const contentParts = [
      {
        type: ContentTypes.TEXT,
        text: 'Base answer.Added answer.',
        agentId: 'agent-main',
        groupId: 1,
      },
    ];

    const repaired = repairMissedVisibleMessageDelta({
      contentParts,
      beforeContentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'Added answer.' }] } },
      beforeText: 'Base answer.',
      afterText: 'Base answer.Added answer.',
      contentMeta: { agentId: 'agent-main____1', groupId: 1 },
    });

    expect(repaired).toBe(true);
    expect(contentParts).toEqual([
      expect.objectContaining({
        text: 'Base answer.',
        agentId: 'agent-main',
        groupId: 1,
      }),
      expect.objectContaining({
        text: 'Added answer.',
        agentId: 'agent-main____1',
        groupId: 1,
      }),
    ]);
  });

  test('never appends an unowned visible delta to an existing parallel participant', () => {
    const beforeContentParts = [
      {
        type: ContentTypes.TEXT,
        text: 'Base answer.',
        agentId: 'agent-main',
        groupId: 1,
      },
    ];
    const contentParts = [
      {
        type: ContentTypes.TEXT,
        text: 'Base answer.Added answer.',
        agentId: 'agent-main',
        groupId: 1,
      },
    ];

    const repaired = repairMissedVisibleMessageDelta({
      contentParts,
      beforeContentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'Added answer.' }] } },
      beforeText: 'Base answer.',
      afterText: 'Base answer.Added answer.',
      contentMeta: {},
    });

    expect(repaired).toBe(true);
    expect(contentParts).toEqual([
      beforeContentParts[0],
      {
        type: ContentTypes.TEXT,
        text: 'Added answer.',
        viventiumUnownedVisible: true,
      },
    ]);
  });

  test('does not duplicate text when upstream aggregation already advanced', () => {
    const contentParts = [{ type: ContentTypes.TEXT, text: 'I hear you.' }];

    const repaired = repairMissedVoiceMessageDelta({
      contentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'I hear you.' }] } },
      beforeText: '',
      afterText: 'I hear you.',
    });

    expect(repaired).toBe(false);
    expect(contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'I hear you.' }]);
  });

  test('preserves streamed whitespace across repaired deltas', () => {
    const contentParts = [{ type: ContentTypes.TEXT, text: 'I' }];

    const repaired = repairMissedVoiceMessageDelta({
      contentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: ' hear you.' }] } },
      beforeText: 'I',
      afterText: 'I',
    });

    expect(repaired).toBe(true);
    expect(extractVisibleTextFromContentParts(contentParts)).toBe('I hear you.');
  });

  test('repairs cumulative snapshot deltas after boundary normalization', () => {
    const contentParts = [];
    const normalize = createMessageDeltaBoundaryNormalizer({ deltaMode: 'snapshot' });

    for (const snapshot of ['I', 'I hear', 'I hear you.']) {
      const event = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text: snapshot }] } },
      });
      repairMissedVoiceMessageDelta({
        contentParts,
        event: event.event,
        data: event.data,
        beforeText: extractVisibleTextFromContentParts(contentParts),
        afterText: extractVisibleTextFromContentParts(contentParts),
      });
    }

    expect(extractVisibleTextFromContentParts(contentParts)).toBe('I hear you.');
  });

  test('does not turn normalized no-response snapshots into malformed visible text', () => {
    const contentParts = [];
    const normalize = createMessageDeltaBoundaryNormalizer({ deltaMode: 'snapshot' });

    for (const snapshot of ['{N', '{NTA', '{NTA}']) {
      const event = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text: snapshot }] } },
      });
      repairMissedVoiceMessageDelta({
        contentParts,
        event: event.event,
        data: event.data,
        beforeText: extractVisibleTextFromContentParts(contentParts),
        afterText: extractVisibleTextFromContentParts(contentParts),
      });
    }

    expect(extractVisibleTextFromContentParts(contentParts)).toBe('{NTA}');
  });

  test('preserves quoted repeated words in cumulative snapshots after boundary normalization', () => {
    const contentParts = [];
    const normalize = createMessageDeltaBoundaryNormalizer({ deltaMode: 'snapshot' });
    const snapshots = [
      'She said "no',
      'She said "no no no',
      'She said "no no no no no no" and waited.',
    ];

    for (const snapshot of snapshots) {
      const event = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text: snapshot }] } },
      });
      repairMissedVoiceMessageDelta({
        contentParts,
        event: event.event,
        data: event.data,
        beforeText: extractVisibleTextFromContentParts(contentParts),
        afterText: extractVisibleTextFromContentParts(contentParts),
      });
    }

    expect(extractVisibleTextFromContentParts(contentParts)).toBe(
      'She said "no no no no no no" and waited.',
    );
  });

  test('missed-delta repair appends already-normalized repeated incremental text exactly', () => {
    const contentParts = [{ type: ContentTypes.TEXT, text: 'ha' }];

    const repaired = repairMissedVoiceMessageDelta({
      contentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'haha' }] } },
      beforeText: 'ha',
      afterText: 'ha',
    });

    expect(repaired).toBe(true);
    expect(extractVisibleTextFromContentParts(contentParts)).toBe('hahaha');
  });

  test('collapses an exact final replay of text already recovered from visible deltas', () => {
    const contentParts = [
      { type: ContentTypes.TEXT, text: 'Already visible answer.' },
      { type: 'cortex_insight', status: 'complete' },
      { type: ContentTypes.TEXT, text: 'Already visible answer.' },
    ];

    const collapsed = collapseRecoveredVisibleTextDuplicate({
      contentParts,
      recoveredText: 'Already visible answer.',
    });

    expect(collapsed).toBe(true);
    expect(contentParts).toEqual([
      { type: ContentTypes.TEXT, text: 'Already visible answer.' },
      { type: 'cortex_insight', status: 'complete' },
    ]);
  });

  test('does not collapse repeated text without an exact recovered replay match', () => {
    const contentParts = [{ type: ContentTypes.TEXT, text: 'hahaha' }];

    expect(collapseRecoveredVisibleTextDuplicate({ contentParts, recoveredText: 'ha' })).toBe(
      false,
    );
    expect(contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'hahaha' }]);
  });
});
