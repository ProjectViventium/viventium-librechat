import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { rapidInputContract } from './rapidInput.helper';

describe('rapid input with process-local storage', () => {
  rapidInputContract(() => new InMemoryJobStore({ ttlAfterComplete: 60_000 }));
});
