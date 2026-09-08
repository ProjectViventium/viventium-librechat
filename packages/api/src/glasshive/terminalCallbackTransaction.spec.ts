import { AsyncLocalStorage } from 'node:async_hooks';
import { mongo } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { createGlassHiveTerminalCallbackTransactionService } from './terminalCallbackTransaction';

function transactionError(label = 'TransientTransactionError', code = 112) {
  const error = new mongo.MongoServerError({ message: 'synthetic transaction failure', code });
  error.addErrorLabel(label);
  return error;
}

function harness() {
  const client = new mongo.MongoClient('mongodb://127.0.0.1:1');
  const session = client.startSession();
  const storage = new AsyncLocalStorage<{
    session: ClientSession;
    afterCommit: Array<() => unknown>;
    afterAbort: Array<() => unknown>;
  }>();
  const startSession = jest.fn(async () => session);
  const service = createGlassHiveTerminalCallbackTransactionService({
    transactionAsyncLocalStorage: storage,
    startSession,
    set: jest.fn(),
  });
  return { session, storage, startSession, service };
}

describe('terminal callback transaction native retry opt-in', () => {
  it('retries only the opted-in owner and restores each aborted attempt before replay', async () => {
    const { service, storage } = harness();
    let attempts = 0;
    let value = 0;
    const published: number[] = [];
    const rolledBack: number[] = [];
    const result = await service.runGlassHiveTerminalCallbackTransaction(
      async () => {
        expect(value).toBe(0);
        const attempt = ++attempts;
        value = attempt;
        service.deferGlassHiveTerminalCallbackAfterAbort(() => {
          rolledBack.push(attempt);
          value = 0;
        });
        service.deferGlassHiveTerminalCallbackAfterCommit(() => {
          expect(storage.getStore()).toBeUndefined();
          published.push(attempt);
        });
        if (attempt === 1) throw transactionError();
        return attempt;
      },
      { retry: 'native' },
    );
    expect({ result, value, published, rolledBack }).toEqual({
      result: 2,
      value: 2,
      published: [2],
      rolledBack: [1],
    });
  });

  it('default owners stay single-attempt even when an inherited child opts in', async () => {
    const { service, startSession } = harness();
    let attempts = 0;
    await expect(
      service.runGlassHiveTerminalCallbackTransaction(() =>
        service.runGlassHiveTerminalCallbackTransaction(
          async () => {
            attempts++;
            throw transactionError();
          },
          { retry: 'native' },
        ),
      ),
    ).rejects.toThrow('synthetic transaction failure');
    expect(attempts).toBe(1);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('an inherited default child uses the opted-in outer owner and its final result', async () => {
    const { service, startSession } = harness();
    let attempts = 0;
    const published: number[] = [];
    const result = await service.runGlassHiveTerminalCallbackTransaction(
      () =>
        service.runGlassHiveTerminalCallbackTransaction(async () => {
          const attempt = ++attempts;
          service.deferGlassHiveTerminalCallbackAfterCommit(() => published.push(attempt));
          if (attempt === 1) throw transactionError();
          return attempt;
        }),
      { retry: 'native' },
    );
    expect({ result, published }).toEqual({ result: 2, published: [2] });
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('restores a successful callback attempt when a commit conflict reruns it', async () => {
    const { session, service } = harness();
    const commit = session.commitTransaction.bind(session);
    let commits = 0;
    jest.spyOn(session, 'commitTransaction').mockImplementation(async () => {
      if (++commits === 1) {
        await session.abortTransaction();
        throw transactionError();
      }
      await commit();
    });
    let value = 0;
    let attempts = 0;
    await service.runGlassHiveTerminalCallbackTransaction(
      async () => {
        expect(value).toBe(0);
        value = ++attempts;
        service.deferGlassHiveTerminalCallbackAfterAbort(() => {
          value = 0;
        });
      },
      { retry: 'native' },
    );
    expect({ commits, attempts, value }).toEqual({ commits: 2, attempts: 2, value: 2 });
  });

  it('retries an unknown commit without rerunning the operation or its final publication', async () => {
    const { session, service } = harness();
    const commit = session.commitTransaction.bind(session);
    let commits = 0;
    jest.spyOn(session, 'commitTransaction').mockImplementation(async () => {
      if (++commits === 1) throw transactionError('UnknownTransactionCommitResult');
      await commit();
    });
    const operation = jest.fn(async () => {
      service.deferGlassHiveTerminalCallbackAfterCommit(publish);
      service.deferGlassHiveTerminalCallbackAfterAbort(rollback);
      return 'saved';
    });
    const publish = jest.fn();
    const rollback = jest.fn();
    await expect(
      service.runGlassHiveTerminalCallbackTransaction(operation, { retry: 'native' }),
    ).resolves.toBe('saved');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(commits).toBe(2);
  });

  it('does not publish or claim rollback when the final commit outcome remains unknown', async () => {
    const { session, service } = harness();
    const error = transactionError('UnknownTransactionCommitResult', 50);
    jest.spyOn(session, 'commitTransaction').mockRejectedValue(error);
    const publish = jest.fn();
    const rollback = jest.fn();
    await expect(
      service.runGlassHiveTerminalCallbackTransaction(
        async () => {
          service.deferGlassHiveTerminalCallbackAfterCommit(publish);
          service.deferGlassHiveTerminalCallbackAfterAbort(rollback);
        },
        { retry: 'native' },
      ),
    ).rejects.toBe(error);
    expect(publish).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back a definitive final abort once in reverse order', async () => {
    const { service } = harness();
    const order: number[] = [];
    await expect(
      service.runGlassHiveTerminalCallbackTransaction(
        async () => {
          service.deferGlassHiveTerminalCallbackAfterAbort(() => order.push(1));
          service.deferGlassHiveTerminalCallbackAfterAbort(() => order.push(2));
          throw new Error('terminal');
        },
        { retry: 'native' },
      ),
    ).rejects.toThrow('terminal');
    expect(order).toEqual([2, 1]);
  });

  it('does not retry dirty state when a rollback callback itself throws a transient error', async () => {
    const { service } = harness();
    const rollback = jest.fn(() => {
      throw transactionError();
    });
    const operation = jest.fn(async () => {
      service.deferGlassHiveTerminalCallbackAfterAbort(rollback);
      throw transactionError();
    });
    await expect(
      service.runGlassHiveTerminalCallbackTransaction(operation, { retry: 'native' }),
    ).rejects.toThrow('rollback');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('does not rerun committed work when publication or session cleanup fails', async () => {
    const { service, session } = harness();
    const error = new Error('publish failed');
    const rollback = jest.fn();
    jest.spyOn(session, 'endSession').mockRejectedValue(new Error('cleanup failed'));
    const operation = jest.fn(async () => {
      service.deferGlassHiveTerminalCallbackAfterAbort(rollback);
      service.deferGlassHiveTerminalCallbackAfterCommit(() => {
        throw error;
      });
    });
    await expect(
      service.runGlassHiveTerminalCallbackTransaction(operation, { retry: 'native' }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
  });
  it('does not treat a callback-owned manual abort as a confirmed commit', async () => {
    const { service } = harness();
    const publish = jest.fn();
    await expect(
      service.runGlassHiveTerminalCallbackTransaction(
        async (session) => {
          service.deferGlassHiveTerminalCallbackAfterCommit(publish);
          await session.abortTransaction();
        },
        { retry: 'native' },
      ),
    ).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });
});
