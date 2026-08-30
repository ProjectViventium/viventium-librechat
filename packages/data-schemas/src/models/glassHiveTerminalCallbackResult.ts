/* === VIVENTIUM START === Durable GlassHive terminal-result receiver CAS model. === VIVENTIUM END === */

import glassHiveTerminalCallbackResultSchema from '~/schema/glassHiveTerminalCallbackResult';
import type { IGlassHiveTerminalCallbackResult } from '~/types/glassHiveTerminalCallbackResult';

export function createGlassHiveTerminalCallbackResultModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.GlassHiveTerminalCallbackResult ||
    mongoose.model<IGlassHiveTerminalCallbackResult>(
      'GlassHiveTerminalCallbackResult',
      glassHiveTerminalCallbackResultSchema,
    )
  );
}
