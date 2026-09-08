/* === VIVENTIUM START === Render typed memory failures without raw provider payloads. === */
import type { MemoryArtifact } from 'librechat-data-provider';
import { useMemo } from 'react';
import { useLocalize } from '~/hooks';
import { memoryProviderFailureCopy, memoryProviderLabel } from './memoryErrorPresentation';

export default function MemoryInfo({ memoryArtifacts }: { memoryArtifacts: MemoryArtifact[] }) {
  const localize = useLocalize();

  const { updatedMemories, deletedMemories, errorMessages, hasStorageFullErrors } = useMemo(() => {
    const updated = memoryArtifacts.filter((art) => art.type === 'update');
    const deleted = memoryArtifacts.filter((art) => art.type === 'delete');
    const errors = memoryArtifacts.filter((art) => art.type === 'error');

    const messages = errors.map((artifact) => {
      try {
        const errorData: {
          errorType?: string;
          provider?: string;
          tokenCount?: number;
          keyLimit?: number;
          partialApplied?: boolean;
        } = JSON.parse(artifact.value as string);
        const errorType =
          typeof errorData?.errorType === 'string' ? errorData.errorType : undefined;
        const providerCopy = memoryProviderFailureCopy(errorType);
        const provider = memoryProviderLabel(errorData?.provider) ?? localize('com_ui_provider');
        let message = localize('com_ui_memory_save_failed');
        let isStorageFull = false;
        const tokens = Number.isFinite(errorData?.tokenCount) ? errorData.tokenCount : 0;
        if (providerCopy) {
          message = localize(providerCopy, { provider });
        } else if (errorType === 'already_exceeded' || errorType === 'would_exceed') {
          isStorageFull = true;
          message = localize(
            errorType === 'already_exceeded'
              ? 'com_ui_memory_already_exceeded'
              : 'com_ui_memory_would_exceed',
            { tokens },
          );
        } else if (errorType === 'key_limit_exceeded' || errorType === 'key_already_exceeded') {
          const limit = errorData.keyLimit;
          message =
            typeof limit === 'number' && Number.isFinite(limit) && limit > 0
              ? localize('com_ui_memory_item_too_large', { limit })
              : localize('com_ui_memory_item_too_large_unknown_limit');
        } else if (errorType === 'revision_conflict') {
          message = localize('com_ui_memory_changed_before_save');
        } else if (errorType === 'writer_interrupted') {
          message = localize('com_ui_memory_save_interrupted');
        }
        if (errorData?.partialApplied === true) {
          message = `${message} ${localize('com_ui_memory_partial_save')}`;
        }
        return { isStorageFull, message };
      } catch {
        return {
          isStorageFull: false,
          message: localize('com_ui_memory_save_failed'),
        };
      }
    });

    return {
      updatedMemories: updated,
      deletedMemories: deleted,
      errorMessages: messages,
      hasStorageFullErrors: messages.some((message) => message.isStorageFull),
    };
  }, [memoryArtifacts, localize]);

  if (memoryArtifacts.length === 0) {
    return null;
  }

  if (updatedMemories.length === 0 && deletedMemories.length === 0 && errorMessages.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4 p-4">
      {updatedMemories.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-text-primary">
            {localize('com_ui_memory_updated_items')}
          </h4>
          <div className="space-y-2">
            {updatedMemories.map((artifact) => (
              <div key={`update-${artifact.key}`} className="rounded-lg p-3">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {artifact.key}
                </div>
                <div className="whitespace-pre-wrap text-sm text-text-primary">
                  {artifact.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {deletedMemories.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-text-primary">
            {localize('com_ui_memory_deleted_items')}
          </h4>
          <div className="space-y-2">
            {deletedMemories.map((artifact) => (
              <div key={`delete-${artifact.key}`} className="rounded-lg p-3 opacity-60">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {artifact.key}
                </div>
                <div className="text-sm italic text-text-secondary">
                  {localize('com_ui_memory_deleted')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {errorMessages.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-red-500">
            {hasStorageFullErrors
              ? localize('com_ui_memory_storage_full')
              : localize('com_ui_memory_error')}
          </h4>
          <div className="space-y-2">
            {errorMessages.map((errorMessage, index) => (
              <div
                key={`${index}-${errorMessage.message}`}
                className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-400"
              >
                {errorMessage.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* === VIVENTIUM END === */
