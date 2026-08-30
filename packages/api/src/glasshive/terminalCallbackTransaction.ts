/* === VIVENTIUM START === Single-attempt GlassHive terminal-callback transaction owner. === */

export type DeferredTerminalCallbackOperation = () => unknown | Promise<unknown>;

interface TransactionSession {
  abortTransaction: () => Promise<unknown>;
  commitTransaction: () => Promise<unknown>;
  endSession: () => Promise<unknown>;
  inTransaction: () => boolean;
  startTransaction: () => void;
}

interface TransactionContext {
  session: TransactionSession;
  afterCommit: DeferredTerminalCallbackOperation[];
  afterAbort: DeferredTerminalCallbackOperation[];
}

export interface TerminalCallbackTransactionMongoose {
  transactionAsyncLocalStorage?: {
    getStore: () => TransactionContext | undefined;
    run: <T>(context: TransactionContext, operation: () => T) => T;
  };
  set: (key: string, value: unknown) => unknown;
  startSession: () => Promise<TransactionSession>;
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

  async function runGlassHiveTerminalCallbackTransaction<T>(
    operation: (session: TransactionSession) => T | Promise<T>,
  ): Promise<T> {
    const inherited = mongoose.transactionAsyncLocalStorage?.getStore()?.session;
    if (inherited?.inTransaction()) return operation(inherited);
    if (!mongoose.transactionAsyncLocalStorage) {
      mongoose.set('transactionAsyncLocalStorage', true);
    }
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
