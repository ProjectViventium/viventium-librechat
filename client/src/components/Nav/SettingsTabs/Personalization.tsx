import { useState, useEffect } from 'react';
import { Switch, useToastContext } from '@librechat/client';
import { useGetUserQuery, useUpdateMemoryPreferencesMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

interface PersonalizationProps {
  hasMemoryOptOut: boolean;
  hasAnyPersonalizationFeature: boolean;
}

export default function Personalization({
  hasMemoryOptOut,
  hasAnyPersonalizationFeature,
}: PersonalizationProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: user } = useGetUserQuery();
  const [referenceSavedMemories, setReferenceSavedMemories] = useState(true);
  /* === VIVENTIUM START ===
   * Feature: Conversation Recall global preference state
   * Added: 2026-02-19
   */
  const [recallAllConversations, setRecallAllConversations] = useState(false);
  /* === VIVENTIUM END === */

  const updateMemoryPreferencesMutation = useUpdateMemoryPreferencesMutation({
    onSuccess: () => {
      showToast({
        message: localize('com_ui_preferences_updated'),
        status: 'success',
      });
    },
    onError: () => {
      showToast({
        message: localize('com_ui_error_updating_preferences'),
        status: 'error',
      });
    },
  });

  // Initialize state from user data
  useEffect(() => {
    if (user?.personalization?.memories !== undefined) {
      setReferenceSavedMemories(user.personalization.memories);
    }
    /* === VIVENTIUM START ===
     * Feature: Conversation Recall global preference hydration
     * Added: 2026-02-19
     */
    if (user?.personalization?.conversation_recall !== undefined) {
      setRecallAllConversations(user.personalization.conversation_recall);
    }
    /* === VIVENTIUM END === */
  }, [user?.personalization?.memories, user?.personalization?.conversation_recall]);

  const handleMemoryToggle = (checked: boolean) => {
    const previous = referenceSavedMemories;
    setReferenceSavedMemories(checked);
    updateMemoryPreferencesMutation.mutate(
      { memories: checked },
      {
        onError: () => setReferenceSavedMemories(previous),
      },
    );
  };

  /* === VIVENTIUM START ===
   * Feature: Conversation Recall global preference handler
   * Added: 2026-02-19
   */
  const handleConversationRecallToggle = (checked: boolean) => {
    const previous = recallAllConversations;
    setRecallAllConversations(checked);
    updateMemoryPreferencesMutation.mutate(
      { conversation_recall: checked },
      {
        onError: () => setRecallAllConversations(previous),
      },
    );
  };
  /* === VIVENTIUM END === */

  if (!hasAnyPersonalizationFeature) {
    return (
      <div className="flex flex-col gap-3 text-sm text-text-primary">
        <div className="text-text-secondary">{localize('com_ui_no_personalization_available')}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm text-text-primary">
      {/* Memory Settings Section */}
      {hasMemoryOptOut && (
        <>
          <div className="border-b border-border-medium pb-3">
            <div className="text-base font-semibold">{localize('com_ui_memory')}</div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div id="reference-saved-memories-label" className="flex items-center gap-2">
                {localize('com_ui_reference_saved_memories')}
              </div>
              <div
                id="reference-saved-memories-description"
                className="mt-1 text-xs text-text-secondary"
              >
                {localize('com_ui_reference_saved_memories_description')}
              </div>
            </div>
            <Switch
              checked={referenceSavedMemories}
              onCheckedChange={handleMemoryToggle}
              disabled={updateMemoryPreferencesMutation.isLoading}
              aria-labelledby="reference-saved-memories-label"
              aria-describedby="reference-saved-memories-description"
            />
          </div>

          {/* === VIVENTIUM START ===
           * Feature: Conversation Recall global preference control
           * Added: 2026-02-19
           */}
          <div className="flex items-center justify-between">
            <div>
              <div id="recall-all-conversations-label" className="flex items-center gap-2">
                {localize('com_ui_recall_all_conversations')}
              </div>
              <div id="recall-all-conversations-description" className="mt-1 text-xs text-text-secondary">
                {localize('com_ui_recall_all_conversations_description')}
              </div>
            </div>
            <Switch
              checked={recallAllConversations}
              onCheckedChange={handleConversationRecallToggle}
              disabled={updateMemoryPreferencesMutation.isLoading}
              aria-labelledby="recall-all-conversations-label"
              aria-describedby="recall-all-conversations-description"
            />
          </div>
          {/* === VIVENTIUM END === */}
        </>
      )}
    </div>
  );
}
