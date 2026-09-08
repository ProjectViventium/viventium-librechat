/* === VIVENTIUM START === Terminal callbacks keep one attempt; replayable writes opt into native retries. === */
import { mongo } from 'mongoose';
import type { ClientSession } from 'mongoose';

export type DeferredTerminalCallbackOperation = () => unknown | Promise<unknown>;

export interface TerminalCallbackTransactionOptions {
  retry?: 'native';
}

interface TransactionContext {
  session: ClientSession;
  afterCommit: DeferredTerminalCallbackOperation[];
  afterAbort: DeferredTerminalCallbackOperation[];
}

export interface TerminalCallbackTransactionMongoose {
  transactionAsyncLocalStorage?: {
    getStore: () => TransactionContext | undefined;
    run: <T>(context: TransactionContext, operation: () => T) => T;
  };
  set: (key: string, value: unknown) => unknown;
  startSession: () => Promise<ClientSession>;
}

export function createGlassHiveTerminalCallbackTransactionService(
  mongoose: TerminalCallbackTransactionMongoose,
) {
  function currentGlassHiveTerminalCallbackTransaction(): TransactionContext | null {
    const context = mongoose.transactionAsyncLocalStorage?.getStore();
    return context?.session?.inTransaction() ? context : null;
  }

  function deferGlassHiveTerminalCallbackAfterCommit(
    operation: DeferredTerminalCallbackOperation,
  ): boolean {
    const context = currentGlassHiveTerminalCallbackTransaction();
    if (!context || typeof operation !== 'function') return false;
    context.afterCommit.push(operation);
    return true;
  }

  function deferGlassHiveTerminalCallbackAfterAbort(
    operation: DeferredTerminalCallbackOperation,
  ): boolean {
    const context = currentGlassHiveTerminalCallbackTransaction();
    if (!context || typeof operation !== 'function') return false;
    context.afterAbort.push(operation);
    return true;
  }

  async function rollbackAttempt(context: TransactionContext | undefined): Promise<void> {
    if (!context) return;
    context.afterCommit.length = 0;
    let failure: Error | undefined;
    for (const operation of context.afterAbort.splice(0).reverse()) {
      try {
        await operation();
      } catch (error) {
        failure ||= Object.assign(new Error('glasshive_terminal_callback_rollback_failed'), {
          cause: error,
        });
      }
    }
    if (failure) throw failure;
  }

  async function runNativeTransaction<T>(
    operation: (session: ClientSession) => T | Promise<T>,
  ): Promise<T> {
    const storage = mongoose.transactionAsyncLocalStorage;
    if (!storage) {
      throw new Error('glasshive_terminal_callback_transaction_storage_unavailable');
    }
    const session = await mongoose.startSession();
    let context: TransactionContext | undefined;
    let committed = false;
    try {
      const result = await session.withTransaction(async () => {
        // A commit conflict can replay a callback that returned successfully.
        await rollbackAttempt(context);
        context = { session, afterCommit: [], afterAbort: [] };
        const value = await storage.run(context, async () => operation(session));
        if (!session.inTransaction()) {
          throw new Error('glasshive_terminal_callback_transaction_ended_by_operation');
        }
        return value;
      });
      committed = true;
      for (const afterCommit of context?.afterCommit || []) await afterCommit();
      return result;
    } catch (error) {
      const unknownCommit =
        error instanceof mongo.MongoError && error.hasErrorLabel('UnknownTransactionCommitResult');
      if (!committed && !unknownCommit) await rollbackAttempt(context);
      throw error;
    } finally {
      // Match native Mongoose cleanup without replacing the operation's result or error.
      await session.endSession().catch(() => undefined);
    }
  }

  async function runGlassHiveTerminalCallbackTransaction<T>(
    operation: (session: ClientSession) => T | Promise<T>,
    options: TerminalCallbackTransactionOptions = {},
  ): Promise<T> {
    const inherited = mongoose.transactionAsyncLocalStorage?.getStore()?.session;
    if (inherited?.inTransaction()) return operation(inherited);
    if (!mongoose.transactionAsyncLocalStorage) {
      mongoose.set('transactionAsyncLocalStorage', true);
    }
    if (options.retry === 'native') return runNativeTransaction(operation);
    const session = await mongoose.startSession();
    session.startTransaction();
    const context: TransactionContext = { session, afterCommit: [], afterAbort: [] };
    let committed = false;
    try {
      const result = await new Promise<T>((resolve, reject) => {
        const storage = mongoose.transactionAsyncLocalStorage;
        if (!storage) {
          reject(new Error('glasshive_terminal_callback_transaction_storage_unavailable'));
          return;
        }
        storage.run(context, () => {
          Promise.resolve(operation(session)).then(resolve, reject);
        });
      });
      await session.commitTransaction();
      committed = true;
      for (const afterCommit of context.afterCommit) await afterCommit();
      return result;
    } catch (error) {
      if (!committed) {
        if (session.inTransaction()) await session.abortTransaction();
        for (const afterAbort of context.afterAbort.reverse()) await afterAbort();
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  return {
    currentGlassHiveTerminalCallbackTransaction,
    deferGlassHiveTerminalCallbackAfterAbort,
    deferGlassHiveTerminalCallbackAfterCommit,
    runGlassHiveTerminalCallbackTransaction,
  };
}

/* === VIVENTIUM END === */
