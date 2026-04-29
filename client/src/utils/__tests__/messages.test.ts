import { ContentTypes } from 'librechat-data-provider';
import { getAllContentText, getLatestText, getTextKey } from '~/utils/messages';

describe('message text utilities', () => {
  it('does not throw when message content is a single malformed object', () => {
    const message = {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      text: '',
      content: { type: ContentTypes.TEXT, text: 'legacy object' },
    } as any;

    expect(getLatestText(message)).toBe('');
    expect(getAllContentText(message)).toBe('');
    expect(getTextKey(message)).toContain('msg-1');
  });

  it('still reads text from normal content arrays', () => {
    const message = {
      messageId: 'msg-2',
      conversationId: 'conv-1',
      text: '',
      content: [
        { type: ContentTypes.TEXT, text: 'first' },
        { type: ContentTypes.TEXT, text: 'second' },
      ],
    } as any;

    expect(getLatestText(message)).toBe('second');
    expect(getAllContentText(message)).toBe('first\nsecond');
  });
});
