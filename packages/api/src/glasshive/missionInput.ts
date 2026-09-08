/* === VIVENTIUM START === Accepted run input carried with terminal evidence. === */
import { z } from 'zod';

const runInputSchema = z.object({
  version: z.literal(1),
  run_id: z.string().min(1).max(160),
  instruction: z.string().min(1),
  continuation_context: z.object({
    version: z.literal(1),
    base_instruction: z.string().min(1).refine((text) => Buffer.byteLength(text) <= 128 * 1024),
    guidance: z.array(z.string().min(1).refine((text) => Buffer.byteLength(text) <= 100 * 1024))
      .max(128).refine((items) => items.reduce((size, text) => size + Buffer.byteLength(text), 0) <= 512 * 1024),
  }).strict().optional(),
}).strict();

export type GlassHiveRunInput = z.infer<typeof runInputSchema>;

export function normalizeGlassHiveRunInput(
  value: unknown,
  runId: string,
): GlassHiveRunInput | undefined {
  if (value == null) return undefined;
  const parsed = runInputSchema.safeParse(value);
  if (!parsed.success || !runId || parsed.data.run_id !== runId) {
    throw Object.assign(new Error('mission_input_identity_invalid'), {
      code: 'mission_input_identity_invalid',
    });
  }
  return parsed.data;
}
/* === VIVENTIUM END === */
