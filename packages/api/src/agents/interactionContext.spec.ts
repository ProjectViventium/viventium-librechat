import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import {
  buildMainContinuityHeaders,
  createMainContinuityFetch,
} from '../continuity/mainContinuity';
import {
  setTrustedInteractionContext,
  projectTrustedNativeInteractionHeaders,
} from './interactionContext';

describe('common native interaction scope', () => {
  test.each([
    { actor_kind: 'external_user' as const, origin: 'interactive' as const },
    { actor_kind: 'system' as const, origin: 'scheduler' as const },
    { actor_kind: 'worker' as const, origin: 'callback' as const },
  ])(
    'binds trusted native authoring scope through the installed SDK: $origin',
    async (interactionContext) => {
      const messages = [
        new HumanMessage({ id: 'source-a', content: 'Keep the exact source goal.' }),
      ];
      const req = {};
      setTrustedInteractionContext(req, {
        ...interactionContext,
        surface: 'workbench',
        source_event_id: 'root-event',
      });
      const headers = buildMainContinuityHeaders({
        context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
        messages,
        sourceMessageIds: ['source-a'],
        logicalTurnId: 'turn-a',
      });
      const chain = headers['X-Viventium-Visible-Message-Chain-B64'];
      const capture = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const actual = new Headers(init?.headers);
        expect(actual.get('X-Viventium-Actor-Kind')).toBe(interactionContext.actor_kind);
        expect(actual.get('X-Viventium-Origin')).toBe(interactionContext.origin);
        expect(JSON.parse(String(init?.body)).messages).toEqual([
          { role: 'user', content: 'Keep the exact source goal.' },
        ]);
        return new Response(
          JSON.stringify({
            id: 'completion-a',
            object: 'chat.completion',
            created: 1,
            model: 'synthetic',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });
      const model = new ChatOpenAI({
        model: 'synthetic',
        apiKey: 'synthetic',
        maxRetries: 0,
        configuration: {
          baseURL: 'https://native.invalid/v1',
          defaultHeaders: projectTrustedNativeInteractionHeaders(req, {
            ...headers,
            'x-viventium-actor-kind': 'tool',
            'X-Viventium-Origin': 'worker',
          }),
          fetch: createMainContinuityFetch(capture, chain, headers),
        },
      });
      expect((await model.invoke(messages)).content).toBe('Done.');
      expect(capture).toHaveBeenCalledTimes(1);
    },
  );

  test('rejects copied, inherited, or body-supplied provenance without WeakMap trust', () => {
    const req = { body: { actor_kind: 'system', origin: 'scheduler' } };
    setTrustedInteractionContext(req, {
      actor_kind: 'system',
      origin: 'scheduler',
      surface: 'workbench',
    });
    const headers = {
      'x-viventium-actor-kind': 'system',
      'X-VIVENTIUM-ORIGIN': 'scheduler',
      'X-Existing': 'keep',
    };
    for (const child of [{ ...req }, Object.create(req), { body: req.body }, null]) {
      expect(projectTrustedNativeInteractionHeaders(child, headers)).toEqual({
        'X-Existing': 'keep',
      });
    }
    expect(headers['X-VIVENTIUM-ORIGIN']).toBe('scheduler');
  });
});
