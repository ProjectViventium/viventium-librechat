import React from 'react';
import { render, screen } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { MessageContext } from '~/Providers';
import Text from '../Parts/Text';

jest.mock('~/components/Chat/Messages/Content/Markdown', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

describe('rendered text identity', () => {
  it('exposes the exact persisted identity and author on the visible message content', () => {
    render(
      <RecoilRoot>
        <MessageContext.Provider
          value={{
            messageId: 'message-private',
            isExpanded: true,
            viventiumPartId: 'content:2,3',
            viventiumAgentId: 'agent-main',
          }}
        >
          <Text text="Main answer." isCreatedByUser={false} showCursor={false} />
        </MessageContext.Provider>
      </RecoilRoot>,
    );

    const content = screen.getByText('Main answer.').closest('.message-content');
    expect(content).toHaveAttribute('data-viventium-part-id', 'content:2,3');
    expect(content).toHaveAttribute('data-viventium-agent-id', 'agent-main');
  });
});
