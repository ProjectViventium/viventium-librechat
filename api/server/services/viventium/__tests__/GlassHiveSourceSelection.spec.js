const {
  selectTrustedLaunchRequestBody,
  trustedUploadedFilesFromRequestBody,
} = require('../GlassHiveSourceSelection');

describe('GlassHiveSourceSelection', () => {
  const mergedRequest = () => ({
    conversationId: 'conversation-rapid',
    messageId: 'assistant-c',
    viventiumSourceEventId: 'event-c',
    viventiumTriggeringSourceSegments: [
      { ordinal: 0, source_event_id: 'event-a', source_index: 0, text: 'A: large mission' },
      { ordinal: 1, source_event_id: 'event-b', source_index: 0, text: 'B: other mission' },
      { ordinal: 2, source_event_id: 'event-c', source_index: 0, text: 'C: quick answer' },
    ],
    files: [
      {
        file_id: 'file-a',
        filename: 'a.png',
        filepath: '/private/owner/a.png',
        type: 'image/png',
        media_group_index: 0,
        source_event_id: 'event-a',
        source_index: 0,
      },
    ],
  });

  test('partitions merged A(file)/B/C into exact mission packets', () => {
    const selectedA = selectTrustedLaunchRequestBody(mergedRequest(), [1]);
    const selectedB = selectTrustedLaunchRequestBody(mergedRequest(), [2]);

    expect(selectedA.requestBody.viventiumSourceEventId).toBe('event-a');
    expect(selectedA.requestBody.viventiumTriggeringSourceSegments).toEqual([
      expect.objectContaining({ ordinal: 0, source_event_id: 'event-a', text: 'A: large mission' }),
    ]);
    expect(trustedUploadedFilesFromRequestBody(selectedA.requestBody)).toEqual([
      { file_id: 'file-a', filename: 'a.png', type: 'image/png', media_group_index: 0 },
    ]);
    expect(selectedB.requestBody.viventiumTriggeringSourceSegments).toEqual([
      expect.objectContaining({ ordinal: 0, source_event_id: 'event-b', text: 'B: other mission' }),
    ]);
    expect(trustedUploadedFilesFromRequestBody(selectedB.requestBody)).toEqual([]);
    expect(JSON.stringify(selectedA.requestBody)).toContain('event-a');
    expect(
      JSON.stringify(trustedUploadedFilesFromRequestBody(selectedA.requestBody)),
    ).not.toContain('/private/owner');
  });

  test('fails a multi-source launch closed when selection is omitted or invalid', () => {
    expect(selectTrustedLaunchRequestBody(mergedRequest()).error).toBe('source_selection_required');
    expect(selectTrustedLaunchRequestBody(mergedRequest(), [4]).error).toBe(
      'invalid_source_selection',
    );
  });

  test('allows a single-source turn to default without model ceremony', () => {
    const requestBody = mergedRequest();
    requestBody.viventiumTriggeringSourceSegments = [
      requestBody.viventiumTriggeringSourceSegments[0],
    ];

    expect(selectTrustedLaunchRequestBody(requestBody)).toEqual({
      requestBody,
      sourceOrdinals: [1],
    });
  });

  test('normalizes a spurious model ordinal when Core has exactly one trusted source', () => {
    const requestBody = mergedRequest();
    requestBody.viventiumTriggeringSourceSegments = [
      requestBody.viventiumTriggeringSourceSegments[0],
    ];

    expect(selectTrustedLaunchRequestBody(requestBody, [2])).toEqual({
      requestBody,
      sourceOrdinals: [1],
    });
  });
});
