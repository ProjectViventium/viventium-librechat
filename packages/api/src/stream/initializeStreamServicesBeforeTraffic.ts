/* === VIVENTIUM START ===
 * Feature: Stream readiness before traffic admission.
 * Purpose: Configure and initialize durable stream services before Core can accept requests.
 */
import { GenerationJobManager, GenerationJobManagerClass } from './GenerationJobManager';
import { createStreamServices } from './createStreamServices';
import type { StreamServices } from './createStreamServices';

interface StreamTrafficAdmissionOptions<T> {
  admitTraffic: () => T | Promise<T>;
  manager?: GenerationJobManagerClass;
  services?: StreamServices;
}

/** Configure and fully initialize stream persistence before opening any traffic listener. */
export async function initializeStreamServicesBeforeTraffic<T>({
  admitTraffic,
  manager = GenerationJobManager,
  services = createStreamServices(),
}: StreamTrafficAdmissionOptions<T>): Promise<T> {
  manager.configure(services);
  try {
    await manager.initialize();
  } catch (error) {
    await manager.destroy();
    throw error;
  }
  return admitTraffic();
}
/* === VIVENTIUM END === */
