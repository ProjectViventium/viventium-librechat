import { ErrorTypes } from 'librechat-data-provider';
import type { Agent, TModelsConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import { validateAgentModel } from './validation';

describe('validateAgentModel', () => {
  it('matches custom provider model lists case-insensitively', async () => {
    const req = {} as Request;
    const res = {} as Response;
    const agent = {
      provider: 'xai',
      model: 'grok-4.20-non-reasoning',
    } as Agent;
    const modelsConfig = {
      xAI: ['grok-4.20-non-reasoning'],
    } as unknown as TModelsConfig;
    const logViolation = jest.fn(async () => undefined);

    await expect(
      validateAgentModel({
        req,
        res,
        agent,
        modelsConfig,
        logViolation,
      }),
    ).resolves.toEqual({ isValid: true });
    expect(logViolation).not.toHaveBeenCalled();
  });

  it('preserves endpoint-not-loaded errors when there is no normalized match', async () => {
    const req = {} as Request;
    const res = {} as Response;
    const agent = {
      provider: 'xai',
      model: 'grok-4.20-non-reasoning',
    } as Agent;
    const modelsConfig = {
      openai: ['gpt-4o'],
    } as unknown as TModelsConfig;
    const logViolation = jest.fn(async () => undefined);

    await expect(
      validateAgentModel({
        req,
        res,
        agent,
        modelsConfig,
        logViolation,
      }),
    ).resolves.toEqual({
      isValid: false,
      error: {
        message: `{ "type": "${ErrorTypes.ENDPOINT_MODELS_NOT_LOADED}", "info": "xai" }`,
      },
    });
  });
});
