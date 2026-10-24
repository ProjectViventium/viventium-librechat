import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { rapidInputContract } from './rapidInput.helper';
import { generationSupersessionContract } from './generationSupersession.helper';

describe('rapid input with process-local storage', () => {
  rapidInputContract(() => new InMemoryJobStore({ ttlAfterComplete: 60_000 }));
  generationSupersessionContract(() => new InMemoryJobStore({ ttlAfterComplete: 60_000 }));
});
