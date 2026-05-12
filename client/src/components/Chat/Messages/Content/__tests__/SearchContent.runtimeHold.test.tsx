import { RecoilRoot } from 'recoil';
import { render } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import SearchContent from '../SearchContent';

jest.mock('~/components/Web/Sources', () => () => <div data-testid="sources" />);

function renderSearchContent(message: TMessage) {
  return render(
    <RecoilRoot>
      <SearchContent message={message} />
    </RecoilRoot>,
  );
}

describe('SearchContent runtime-hold no-response rendering', () => {
  test('does not fall back to rendering message.text when runtime-hold NTA content is hidden', () => {
    const message = {
      messageId: 'assistant-runtime-hold',
      conversationId: 'convo-public-safe',
      parentMessageId: 'user-1',
      sender: 'Viventium',
      text: '{NTA}',
      isCreatedByUser: false,
      content: [
        {
          type: ContentTypes.TEXT,
          text: '{NTA}',
          viventium_runtime_hold: true,
        },
      ],
    } as unknown as TMessage;

    const { container, queryByText } = renderSearchContent(message);

    expect(queryByText('{NTA}')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
