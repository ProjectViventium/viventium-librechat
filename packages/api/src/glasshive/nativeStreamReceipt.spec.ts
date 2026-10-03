import { ChatOpenAI } from '@langchain/openai';

describe('native streamed model receipt', () => {
  it('retains exactly the terminal actual model when Fast was requested', async () => {
    const requested = 'grok-build:grok-4.7-build-fast';
    const actual = 'grok-build:grok-4.7';
    const chunks = [
      { model: requested, choices: [{ index:0, delta:{role:'assistant'}, finish_reason:null }] },
      { model: requested, choices: [{ index:0, delta:{content:'Ready.'}, finish_reason:null }] },
      { model: actual, choices: [{ index:0, delta:{}, finish_reason:'stop' }] },
    ];
    const fetch = jest.fn(async () => new Response(chunks.map(c => `data: ${JSON.stringify({
      id:'synthetic', object:'chat.completion.chunk', created:1, ...c })}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }));
    const llm = new ChatOpenAI({ model: requested, streaming:true, streamUsage:false, apiKey:'synthetic',
      configuration: { baseURL:'https://synthetic.invalid/v1', fetch } });
    const output = await llm.invoke('Synthetic request.');
    expect(output.response_metadata.model_name).toBe(actual);
    expect(output.content).toBe('Ready.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
