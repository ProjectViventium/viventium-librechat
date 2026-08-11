import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import { TextDecoder, TextEncoder } from 'util';
import { migratePendingTextDraft } from '../useAutoSave';
import { getDraft, setDraft } from '~/utils/drafts';

describe('pending conversation draft migration', () => {
  const canonicalConversationId = 'conversation-canonical';

  beforeAll(() => {
    Object.assign(globalThis, { TextEncoder, TextDecoder });
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it('does not resurrect an already-submitted pending draft after completion', () => {
    setDraft({ id: Constants.PENDING_CONVO, value: 'already submitted' });
    setDraft({ id: canonicalConversationId, value: 'older canonical draft' });

    migratePendingTextDraft(canonicalConversationId, '');

    expect(
      localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}${Constants.PENDING_CONVO}`),
    ).toBeNull();
    expect(getDraft(canonicalConversationId)).toBe('');
  });

  it('preserves text that is still visibly being authored when generation completes', () => {
    setDraft({ id: Constants.PENDING_CONVO, value: 'still typing' });

    migratePendingTextDraft(canonicalConversationId, 'still typing');

    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}${canonicalConversationId}`)).toBe(
      btoa('still typing'),
    );
  });
});
