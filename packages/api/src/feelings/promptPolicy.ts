import { z } from 'zod';
import { getRequiredPromptText } from '../prompts/runtime';
import { FEELING_BAND_IDS, FEELING_LEVEL_IDS } from './types';

const text = z.string().min(1);
const policySchema = z.object({
  frame: text,
  behavior: text,
  directAnswer: text,
  levels: z.record(z.enum(FEELING_BAND_IDS), z.record(z.enum(FEELING_LEVEL_IDS), text)),
});
let previousText = '';
let previousPolicy: z.infer<typeof policySchema> | undefined;

export function getFeelingPromptPolicy() {
  const source = getRequiredPromptText('feelings.capsule_policy');
  if (previousPolicy && source === previousText) return previousPolicy;
  try {
    const policy = policySchema.parse(JSON.parse(source));
    if (
      FEELING_BAND_IDS.some((band) =>
        FEELING_LEVEL_IDS.some((level) => !policy.levels[band]?.[level]),
      )
    ) {
      throw new Error('Feeling prompt policy is missing a level');
    }
    previousPolicy = policy;
    previousText = source;
    return policy;
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      code: 'required_prompt_invalid',
    });
  }
}
