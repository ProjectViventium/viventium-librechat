import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';

describe('stream startup traffic admission', () => {
  test('admits traffic only after configured stream initialization completes', async () => {
    const { initializeStreamServicesBeforeTraffic } = await import(
      '../initializeStreamServicesBeforeTraffic'
    );
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const initializeStore = store.initialize.bind(store);
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    jest.spyOn(store, 'initialize').mockImplementation(async () => {
      await initializationGate;
      await initializeStore();
    });
    const manager = new GenerationJobManagerClass();
    const admitTraffic = jest.fn();

    const startup = initializeStreamServicesBeforeTraffic({
      manager,
      services: { jobStore: store, eventTransport: new InMemoryEventTransport() },
      admitTraffic,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(admitTraffic).not.toHaveBeenCalled();
    releaseInitialization();
    await startup;
    expect(admitTraffic).toHaveBeenCalledTimes(1);
    await manager.destroy();
  });

  test('does not admit traffic when configured stream initialization fails', async () => {
    const { initializeStreamServicesBeforeTraffic } = await import(
      '../initializeStreamServicesBeforeTraffic'
    );
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const destroyStore = jest.spyOn(store, 'destroy');
    jest.spyOn(store, 'initialize').mockRejectedValue(new Error('stream initialization failed'));
    const manager = new GenerationJobManagerClass();
    const admitTraffic = jest.fn();

    await expect(
      initializeStreamServicesBeforeTraffic({
        manager,
        services: { jobStore: store, eventTransport: new InMemoryEventTransport() },
        admitTraffic,
      }),
    ).rejects.toThrow('stream initialization failed');
    expect(admitTraffic).not.toHaveBeenCalled();
    expect(destroyStore).toHaveBeenCalledTimes(1);
    await manager.destroy();
  });

  test('does not reconfigure away a job accepted after traffic admission', async () => {
    const { initializeStreamServicesBeforeTraffic } = await import(
      '../initializeStreamServicesBeforeTraffic'
    );
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const destroyStore = jest.spyOn(store, 'destroy');
    const manager = new GenerationJobManagerClass();

    await initializeStreamServicesBeforeTraffic({
      manager,
      services: { jobStore: store, eventTransport: new InMemoryEventTransport() },
      admitTraffic: () => manager.createJob('accepted-after-ready', 'owner-a'),
    });

    await expect(manager.getJob('accepted-after-ready')).resolves.toMatchObject({
      streamId: 'accepted-after-ready',
      status: 'running',
    });
    expect(destroyStore).not.toHaveBeenCalled();
    await manager.destroy();
  });

  test('rejects destructive reconfiguration while an accepted job remains active', async () => {
    const firstStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      jobStore: firstStore,
      eventTransport: new InMemoryEventTransport(),
    });
    await manager.initialize();
    await manager.createJob('accepted-before-reconfigure', 'owner-a');

    expect(() =>
      manager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
        eventTransport: new InMemoryEventTransport(),
      }),
    ).toThrow('Generation stream manager is unavailable');
    await expect(manager.getJob('accepted-before-reconfigure')).resolves.toMatchObject({
      streamId: 'accepted-before-reconfigure',
      status: 'running',
    });

    await manager.destroy();
  });
});
