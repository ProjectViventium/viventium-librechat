import React, { useState } from 'react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import {
  OGDialog,
  OGDialogTemplate,
  Button,
  Label,
  Input,
  Spinner,
  useToastContext,
} from '@librechat/client';
import { useCreateMemoryMutation } from '~/data-provider';
import { useLocalize, useHasAccess } from '~/hooks';

interface MemoryCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  triggerRef?: React.MutableRefObject<HTMLButtonElement | null>;
  /* === VIVENTIUM START === Match manual writes to the configured memory policy. === */
  validKeys?: string[];
  /* === VIVENTIUM END === */
}

export default function MemoryCreateDialog({
  open,
  onOpenChange,
  children,
  triggerRef,
  validKeys,
}: MemoryCreateDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.CREATE,
  });

  const { mutate: createMemory, isLoading } = useCreateMemoryMutation({
    onSuccess: () => {
      showToast({
        message: localize('com_ui_memory_created'),
        status: 'success',
      });
      onOpenChange(false);
      setKey('');
      setValue('');
      setTimeout(() => {
        triggerRef?.current?.focus();
      }, 0);
    },
    onError: (error: Error) => {
      let errorMessage = localize('com_ui_error');

      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as any;
        if (axiosError.response?.data?.error) {
          errorMessage = axiosError.response.data.error;

          // Check for duplicate key error
          if (axiosError.response?.status === 409 || errorMessage.includes('already exists')) {
            errorMessage = localize('com_ui_memory_key_exists');
          }
          // Check for key validation error (lowercase and underscores only)
          else if (errorMessage.includes('lowercase letters and underscores')) {
            errorMessage = localize('com_ui_memory_key_validation');
          }
        }
      } else if (error.message) {
        errorMessage = error.message;
      }

      showToast({
        message: errorMessage,
        status: 'error',
      });
    },
  });

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  /* === VIVENTIUM START ===
   * The server owns the governed key list. Reject impossible input before issuing a request while
   * preserving unrestricted upstream installs that do not configure valid keys.
   * === VIVENTIUM END === */
  const normalizedKey = key.trim();
  const hasGovernedKeys = (validKeys?.length ?? 0) > 0;
  const isKeyInvalid =
    normalizedKey.length > 0 && hasGovernedKeys && !validKeys?.includes(normalizedKey);
  const allowedKeysLabel = validKeys?.join(', ') ?? '';

  const handleSave = () => {
    if (!hasCreateAccess) {
      return;
    }

    if (!key.trim() || !value.trim()) {
      showToast({
        message: localize('com_ui_field_required'),
        status: 'error',
      });
      return;
    }

    if (isKeyInvalid) {
      showToast({
        message: localize('com_ui_memory_key_not_allowed', { 0: allowedKeysLabel }),
        status: 'error',
      });
      return;
    }

    createMemory({
      key: normalizedKey,
      value: value.trim(),
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey && hasCreateAccess) {
      handleSave();
    }
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      {children}
      <OGDialogTemplate
        title={localize('com_ui_create_memory')}
        showCloseButton={false}
        className="w-11/12 md:max-w-lg"
        main={
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="memory-key" className="text-sm font-medium text-text-primary">
                {localize('com_ui_key')}
              </Label>
              <Input
                id="memory-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder={localize('com_ui_enter_key')}
                className="w-full"
                list={hasGovernedKeys ? 'memory-valid-keys' : undefined}
                aria-invalid={isKeyInvalid}
                aria-describedby="memory-key-guidance"
              />
              {hasGovernedKeys && (
                <datalist id="memory-valid-keys">
                  {validKeys?.map((validKey) => (
                    <option key={validKey} value={validKey} />
                  ))}
                </datalist>
              )}
              <p
                id="memory-key-guidance"
                role={isKeyInvalid ? 'alert' : undefined}
                className={isKeyInvalid ? 'text-xs text-red-600' : 'text-xs text-text-secondary'}
              >
                {hasGovernedKeys
                  ? localize(
                      isKeyInvalid ? 'com_ui_memory_key_not_allowed' : 'com_ui_memory_allowed_keys',
                      { 0: allowedKeysLabel },
                    )
                  : localize('com_ui_memory_key_hint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="memory-value" className="text-sm font-medium text-text-primary">
                {localize('com_ui_value')}
              </Label>
              <textarea
                id="memory-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder={localize('com_ui_enter_value')}
                className="min-h-[100px] w-full resize-none rounded-lg border border-border-light bg-transparent px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-heavy"
                rows={4}
              />
            </div>
          </div>
        }
        buttons={
          <Button
            type="button"
            variant="submit"
            onClick={handleSave}
            disabled={isLoading || !normalizedKey || !value.trim() || isKeyInvalid}
            className="text-white"
            aria-label={localize('com_ui_create_memory')}
          >
            {isLoading ? <Spinner className="size-4" /> : localize('com_ui_create')}
          </Button>
        }
      />
    </OGDialog>
  );
}
