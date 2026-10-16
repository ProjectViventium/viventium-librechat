import { claimTelegramDeliveriesWhenReady, notifyTelegramDeliveryReady } from './telegramDeliveryWake';
import { InMemoryEventTransport } from '../stream/implementations/InMemoryEventTransport';

describe('Telegram delivery wake hint over the existing durable claim', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick'] }));
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('wakes immediately after an empty claim without waiting for the poll timer', async () => {
    const claim = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ deliveryId: 'one' }]);
    const result = claimTelegramDeliveriesWhenReady(claim, 5_000);
    await Promise.resolve();
    notifyTelegramDeliveryReady();
    await expect(result).resolves.toEqual([{ deliveryId: 'one' }]);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not lose a notification committed during the first claim', async () => {
    const claim = jest.fn().mockImplementationOnce(async () => {
      notifyTelegramDeliveryReady();
      return [];
    }).mockResolvedValueOnce([{ deliveryId: 'raced' }]);
    await expect(claimTelegramDeliveriesWhenReady(claim, 5_000)).resolves.toEqual([{ deliveryId: 'raced' }]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps no-notification and cross-process recovery bounded by the existing poll interval', async () => {
    const claim = jest.fn().mockResolvedValue([]);
    const result = claimTelegramDeliveriesWhenReady(claim, 60_000);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(claim).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual([]);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps delivery authority in the claim when competing waiters wake together', async () => {
    const first = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ deliveryId: 'only-once' }]);
    const second = jest.fn().mockResolvedValue([]);
    const results = [claimTelegramDeliveriesWhenReady(first, 5_000),
      claimTelegramDeliveriesWhenReady(second, 5_000)];
    await Promise.resolve();
    notifyTelegramDeliveryReady();
    await expect(Promise.all(results)).resolves.toEqual([[{ deliveryId: 'only-once' }], []]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels wait and removes its subscription without making another claim', async () => {
    const subscribe = jest.spyOn(InMemoryEventTransport.prototype, 'subscribe');
    const controller = new AbortController();
    const claim = jest.fn().mockResolvedValue([]);
    const result = claimTelegramDeliveriesWhenReady(claim, 5_000, controller.signal);
    const subscription = subscribe.mock.results[0].value;
    const unsubscribe = jest.spyOn(subscription, 'unsubscribe');
    await Promise.resolve();
    controller.abort();
    await expect(result).resolves.toEqual([]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('releases timers and subscriptions after a failed claim and returns existing rows immediately', async () => {
    const subscribe = jest.spyOn(InMemoryEventTransport.prototype, 'subscribe');
    const failed = claimTelegramDeliveriesWhenReady(async () => { throw new Error('database unavailable'); }, 5_000);
    const unsubscribe = jest.spyOn(subscribe.mock.results[0].value, 'unsubscribe');
    await expect(failed).rejects.toThrow('database unavailable');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await expect(claimTelegramDeliveriesWhenReady(async () => [{ deliveryId: 'ready' }], 5_000))
      .resolves.toEqual([{ deliveryId: 'ready' }]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN, Infinity])('keeps immediate claims compatible for waitMs=%s', async (waitMs) => {
    const claim = jest.fn().mockResolvedValue([]);
    await expect(claimTelegramDeliveriesWhenReady(claim, waitMs)).resolves.toEqual([]);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
