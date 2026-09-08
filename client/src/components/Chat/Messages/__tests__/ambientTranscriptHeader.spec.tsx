import { render, renderHook, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import MessageParts from '~/components/Chat/Messages/MessageParts';
import useMessageActions from '~/hooks/Messages/useMessageActions';

jest.mock('jotai', () => ({ useAtomValue: () => 'text-base', atom: jest.fn() }));
jest.mock('recoil', () => ({ useRecoilValue: () => false }));
jest.mock('librechat-data-provider/react-query', () => ({ useUpdateFeedbackMutation: () => ({mutate:jest.fn()}) }));
jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation:{endpoint:'agents',agent_id:'active-agent'}, regenerate:jest.fn() }),
  useAssistantsMapContext: () => ({}),
  useAgentsMapContext: () => ({'active-agent':{name:'Configured assistant'}}),
}));
jest.mock('~/hooks/AuthContext', () => ({useAuthContext:()=>({user:{name:'User'}})}));
jest.mock('~/hooks/Chat', () => ({useGetAddedConvo:()=>jest.fn()}));
jest.mock('~/hooks/Messages/useCopyToClipboard', () => ()=>jest.fn());
jest.mock('~/hooks', () => ({
  useLocalize: () => (key:keyof typeof mockTranslations, args?:{0?:string}) => (mockTranslations[key] ?? key).replace('{{0}}',args?.[0] ?? ''),
  useAttachments: () => ({}),
  useMessageHelpers: () => ({agent:{name:'Configured assistant'},conversation:{endpoint:'agents'}}),
  useContentMetadata: () => ({hasParallelContent:false}),
}));
jest.mock('~/store', () => ({}));
jest.mock('~/utils', () => ({
  cn:(...values:string[])=>values.join(' '),
  getMessageAriaLabel:()=> 'Message',
  getVoiceTranscriptLabel:jest.requireActual('~/utils/messages').getVoiceTranscriptLabel,
}));
jest.mock('~/components/Chat/Messages/MessageIcon', () => ()=>null);
jest.mock('~/components/Chat/Messages/Content/ContentParts', () => ()=>null);
jest.mock('~/components/Chat/Messages/MultiMessage', () => ()=>null);
jest.mock('~/components/Chat/Messages/SiblingSwitch', () => ()=>null);
jest.mock('~/components/Chat/Messages/HoverButtons', () => ()=>null);
jest.mock('~/components/Chat/Messages/SubRow', () => ()=>null);

const base:TMessage={messageId:'ambient-1',conversationId:'conversation-1',parentMessageId:null,isCreatedByUser:false,text:'Retained call speech',sender:'Unknown'};
const header = (message:TMessage, path:string) => {
  if(path==='content') {render(<MessageParts message={message} currentEditId={null}/>);return screen.getByRole('heading').textContent;}
  return renderHook(()=>useMessageActions({message,currentEditId:null})).result.current.messageLabel;
};
describe.each(['content','legacy'])('%s ambient speaker header',path=>{
  it.each(['listen_only_transcript','voice_ambient_transcript'])('keeps typed %s speaker provenance',type=>{
    expect(header({...base,metadata:{viventium:{type,speakerLabel:'Unknown'}}},path)).toBe('Unknown · Call transcript');
  });
  it('retains a generic speaker label',()=>{
    expect(header({...base,metadata:{viventium:{type:'voice_ambient_transcript',speakerLabel:'Speaker 2'}}},path)).toBe('Speaker 2 · Call transcript');
  });
  it('does not promote malformed speaker data to the assistant name',()=>{
    expect(header({...base,metadata:{viventium:{type:'listen_only_transcript',speakerLabel:{name:'User'}}}},path)).toBe('Unknown · Call transcript');
  });
  it.each([undefined,{viventium:{type:'regular_reply',speakerLabel:'Unknown'}}])('keeps ordinary assistant identity',metadata=>{
    expect(header({...base,metadata},path)).toBe('Configured assistant');
  });
  it('does not reclassify a user turn from metadata',()=>{
    expect(header({...base,isCreatedByUser:true,metadata:{viventium:{type:'listen_only_transcript',speakerLabel:'Unknown'}}},path)).toBe(mockTranslations.com_user_message);
  });
});
