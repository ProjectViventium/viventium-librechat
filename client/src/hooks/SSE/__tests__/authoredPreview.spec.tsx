import { renderHook, act } from '@testing-library/react';
import { ContentTypes, StepTypes } from 'librechat-data-provider';
import type { TMessage, EventSubmission, TContentData } from 'librechat-data-provider';
import useContentHandler from '../useContentHandler';
import useStepHandler from '../useStepHandler';
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
jest.mock('~/utils', () => ({ addFileToCache: jest.fn() }));

test('authored preview survives activity, is replaced, and never enters final content', () => {
  const user = {
    messageId: 'question',
    conversationId: 'conversation',
    isCreatedByUser: true,
    text: 'Question',
  } as TMessage;
  const response = {
    messageId: 'answer',
    conversationId: 'conversation',
    isCreatedByUser: false,
    text: '',
    content: [],
  } as TMessage;
  let messages = [user, response];
  const getMessages = () => messages;
  const setMessages = (value: TMessage[]) => {
    messages = value;
  };
  const submission = {
    userMessage: user,
    initialResponse: response,
    messages: [user],
    conversation: {},
  } as EventSubmission;
  const { result } = renderHook(() => ({
    content: useContentHandler({ getMessages, setMessages }),
    step: useStepHandler({
      getMessages,
      setMessages,
      announcePolite: () => undefined,
      lastAnnouncementTimeRef: { current: 0 },
    }),
  }));
  const preview = (text: string, messageId = 'answer') =>
    act(() =>
      result.current.content.contentHandler({
        submission,
        data: {
          type: ContentTypes.TEXT,
          preview: true,
          edited: true,
          index: 0,
          text,
          messageId,
          conversationId: 'conversation',
        } as TContentData,
      }),
    );
  const step = (event: string, data: any) =>
    act(() => result.current.step.stepHandler({ event, data }, submission));
  preview('Timezone: UTC.');
  expect((messages[1] as any).__viventiumAssistantPreview).toBe('Timezone: UTC.');
  expect(messages[1].content).toEqual([]);
  step('on_run_step', {
    id: 'step',
    runId: 'answer',
    index: 0,
    type: StepTypes.MESSAGE_CREATION,
    stepDetails: { type: StepTypes.MESSAGE_CREATION, message_creation: { message_id: 'answer' } },
  });
  step('on_reasoning_delta', {
    id: 'step',
    delta: {
      content: [
        {
          type: ContentTypes.HARNESS_ACTIVITY,
          harness_activity: { event: 'tool', summary: 'Checking page.' },
        },
      ],
    },
  });
  expect((messages[1] as any).__viventiumAssistantPreview).toBe('Timezone: UTC.');
  preview('Other', 'foreign');
  expect((messages[1] as any).__viventiumAssistantPreview).toBe('Timezone: UTC.');
  preview('Checking the page.');
  expect((messages[1] as any).__viventiumAssistantPreview).toBe('Checking the page.');
  preview('');
  step('on_run_step', {
    id: 'final-step',
    runId: 'answer',
    index: 1,
    type: StepTypes.MESSAGE_CREATION,
    stepDetails: { type: StepTypes.MESSAGE_CREATION, message_creation: { message_id: 'answer' } },
  });
  step('on_message_delta', {
    id: 'final-step',
    delta: { content: [{ type: ContentTypes.TEXT, text: 'Final answer only.' }] },
  });
  expect((messages[1] as any).__viventiumAssistantPreview).toBe('');
  expect(JSON.stringify(messages[1].content)).not.toContain('Timezone');
  expect(JSON.stringify(messages[1].content)).toContain('Final answer only.');
});
