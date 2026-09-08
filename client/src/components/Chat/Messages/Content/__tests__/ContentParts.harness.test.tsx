import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ContentTypes, type TMessageContentParts } from 'librechat-data-provider';
import { RecoilRoot } from 'recoil';
import ContentParts from '../ContentParts';

jest.mock('../Part', () => ({
  __esModule: true,
  default: function MockPart({ part, isSubmitting, harnessActivityGrouped }: any) {
    const React = jest.requireActual('react');
    const { ContentTypes } = jest.requireActual('librechat-data-provider');
    const HarnessActivity = jest.requireActual('../HarnessActivity').default;
    const { MessageContext } = jest.requireActual('~/Providers');
    const identity = React.useContext(MessageContext);
    return (
      <div data-part-id={identity?.viventiumPartId} data-agent-id={identity?.viventiumAgentId}>
        {part.type === ContentTypes.HARNESS_ACTIVITY ? (
          <HarnessActivity
            summary={part.harness_activity.summary}
            isSubmitting={isSubmitting}
            grouped={harnessActivityGrouped}
          />
        ) : (
          part.text
        )}
      </div>
    );
  },
}));
jest.mock('../MemoryArtifacts', () => ({ __esModule: true, default: () => null }));
jest.mock('~/components/Web/Sources', () => ({ __esModule: true, default: () => null }));
jest.mock('../SiblingHeader', () => ({ __esModule: true, default: () => null }));

const activity = (
  summary: string,
  agentId = 'agent-a',
  groupId?: number,
): TMessageContentParts => ({
  type: ContentTypes.HARNESS_ACTIVITY,
  agentId,
  groupId,
  harness_activity: { event: 'tool', summary },
});
const message = (content: TMessageContentParts[], streaming = false) => (
  <RecoilRoot>
    <ContentParts
      content={content}
      messageId="message-a"
      isCreatedByUser={false}
      isLast={true}
      isLatestMessage={true}
      isSubmitting={streaming}
    />
  </RecoilRoot>
);

describe('message harness activity disclosure', () => {
  it('keeps one expandable activity history while the answer and new events stream', () => {
    const content = [
      activity('Started'),
      {
        type: ContentTypes.TEXT,
        text: 'Useful answer',
        agentId: 'agent-a',
      } as TMessageContentParts,
    ];
    const { container, rerender, unmount } = render(message(content, true));
    fireEvent.click(screen.getByText('Activity'));
    rerender(message([...content, activity('Completed')], false));

    expect(screen.getAllByText('Activity')).toHaveLength(1);
    expect(container.querySelector('details')).toHaveAttribute('open');
    expect(screen.getByText('Useful answer')).toBeVisible();
    expect(screen.getByText('Started')).toBeVisible();
    expect(screen.getByText('Completed')).toBeVisible();
    expect(screen.getByText('Completed').closest('[data-part-id]')).toHaveAttribute(
      'data-part-id',
      'content:2',
    );
    expect(screen.getByText('Started').closest('[data-part-id]')).toHaveAttribute(
      'data-agent-id',
      'agent-a',
    );
    expect(content).toHaveLength(2);

    unmount();
    const restored = render(message([...content, activity('Completed')]));
    expect(screen.getAllByText('Activity')).toHaveLength(1);
    expect(restored.container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Useful answer')).toBeVisible();
  });

  it('keeps different authors and parallel rounds separate and ignores empty activity', () => {
    const { container } = render(
      message([
        activity('A started', 'agent-a', 0),
        activity('B started', 'agent-b', 0),
        activity('A done', 'agent-a', 0),
        activity('A next round', 'agent-a', 1),
        activity('  ', 'agent-c', 1),
      ]),
    );
    expect(screen.getAllByText('Activity')).toHaveLength(3);
    const panels = Array.from(container.querySelectorAll('details'));
    expect(panels.find((panel) => panel.textContent?.includes('A started'))).toHaveTextContent(
      'A done',
    );
    expect(panels.find((panel) => panel.textContent?.includes('A started'))).not.toHaveTextContent(
      'B started',
    );
    expect(
      panels.find((panel) => panel.textContent?.includes('A next round')),
    ).not.toHaveTextContent('A started');
  });
});
