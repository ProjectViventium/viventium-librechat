import React, { useState } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { EModelEndpoint, alternateName, isAssistantsEndpoint } from 'librechat-data-provider';
import {
  useRevokeUserKeyMutation,
  useRevokeAllUserKeysMutation,
} from 'librechat-data-provider/react-query';
import {
  Label,
  Button,
  Spinner,
  OGDialog,
  Dropdown,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogFooter,
  OGDialogContent,
  useToastContext,
  OGDialogTrigger,
} from '@librechat/client';
import type { TDialogProps } from '~/common';
import { useUserKey, useLocalize } from '~/hooks';
import { NotificationSeverity } from '~/common';
import CustomConfig from './CustomEndpoint';
import GoogleConfig from './GoogleConfig';
import OpenAIConfig from './OpenAIConfig';
import OtherConfig from './OtherConfig';
import HelpText from './HelpText';
import { logger } from '~/utils';

const endpointComponents = {
  [EModelEndpoint.google]: GoogleConfig,
  [EModelEndpoint.openAI]: OpenAIConfig,
  [EModelEndpoint.custom]: CustomConfig,
  [EModelEndpoint.azureOpenAI]: OpenAIConfig,
  [EModelEndpoint.assistants]: OpenAIConfig,
  [EModelEndpoint.azureAssistants]: OpenAIConfig,
  default: OtherConfig,
};

const formSet: Set<string> = new Set([
  EModelEndpoint.openAI,
  EModelEndpoint.custom,
  EModelEndpoint.azureOpenAI,
  EModelEndpoint.assistants,
  EModelEndpoint.azureAssistants,
]);

const EXPIRY = {
  THIRTY_MINUTES: { label: 'in 30 minutes', value: 30 * 60 * 1000 },
  TWO_HOURS: { label: 'in 2 hours', value: 2 * 60 * 60 * 1000 },
  TWELVE_HOURS: { label: 'in 12 hours', value: 12 * 60 * 60 * 1000 },
  ONE_DAY: { label: 'in 1 day', value: 24 * 60 * 60 * 1000 },
  ONE_WEEK: { label: 'in 7 days', value: 7 * 24 * 60 * 60 * 1000 },
  ONE_MONTH: { label: 'in 30 days', value: 30 * 24 * 60 * 60 * 1000 },
  NEVER: { label: 'never', value: 0 },
};

const RevokeKeysButton = ({
  endpoint,
  disabled,
  setDialogOpen,
  removalMode = 'revoke',
}: {
  endpoint: string;
  disabled: boolean;
  setDialogOpen: (open: boolean) => void;
  /* === VIVENTIUM START ===
   * Feature: Truthful local credential removal.
   * Purpose: A local database deletion must never claim to revoke provider-side access.
   * === VIVENTIUM END === */
  removalMode?: 'revoke' | 'disconnect';
}) => {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const { showToast } = useToastContext();
  const revokeKeyMutation = useRevokeUserKeyMutation(endpoint);
  const revokeKeysMutation = useRevokeAllUserKeysMutation();
  const disconnectOnly = removalMode === 'disconnect';

  const handleSuccess = () => {
    showToast({
      message: localize(
        disconnectOnly ? 'com_ui_disconnect_key_success' : 'com_ui_revoke_key_success',
      ),
      status: NotificationSeverity.SUCCESS,
    });

    if (!setDialogOpen) {
      return;
    }

    setDialogOpen(false);
  };

  const handleError = () => {
    showToast({
      message: localize(disconnectOnly ? 'com_ui_disconnect_key_error' : 'com_ui_revoke_key_error'),
      status: NotificationSeverity.ERROR,
    });
  };

  const onClick = () => {
    revokeKeyMutation.mutate(
      {},
      {
        onSuccess: handleSuccess,
        onError: handleError,
      },
    );
  };

  const isLoading = revokeKeyMutation.isLoading || revokeKeysMutation.isLoading;

  return (
    <div className="flex items-center justify-between">
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <Button
            variant="destructive"
            className="flex items-center justify-center rounded-lg transition-colors duration-200"
            onClick={() => setOpen(true)}
            disabled={disabled}
          >
            {localize(disconnectOnly ? 'com_ui_connected_accounts_disconnect' : 'com_ui_revoke')}
          </Button>
        </OGDialogTrigger>
        <OGDialogContent className="max-w-[450px]">
          <OGDialogHeader>
            <OGDialogTitle>
              {localize(
                disconnectOnly ? 'com_ui_disconnect_key_endpoint' : 'com_ui_revoke_key_endpoint',
                { 0: endpoint },
              )}
            </OGDialogTitle>
          </OGDialogHeader>
          <div className="py-4">
            <Label className="text-left text-sm font-medium">
              {localize(
                disconnectOnly ? 'com_ui_disconnect_key_confirm' : 'com_ui_revoke_key_confirm',
              )}
            </Label>
          </div>
          <OGDialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {localize('com_ui_cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={onClick}
              disabled={isLoading}
              className="bg-destructive text-white transition-all duration-200 hover:bg-destructive/80"
            >
              {isLoading ? (
                <Spinner />
              ) : (
                localize(disconnectOnly ? 'com_ui_connected_accounts_disconnect' : 'com_ui_revoke')
              )}
            </Button>
          </OGDialogFooter>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
};

const SetKeyDialog = ({
  open,
  onOpenChange,
  endpoint,
  endpointType,
  userProvideURL,
  removalMode = 'revoke',
}: Pick<TDialogProps, 'open' | 'onOpenChange'> & {
  endpoint: EModelEndpoint | string;
  endpointType?: EModelEndpoint;
  userProvideURL?: boolean | null;
  /** Viventium local-only removal wording for Connected Accounts. */
  removalMode?: 'revoke' | 'disconnect';
}) => {
  const methods = useForm({
    defaultValues: {
      apiKey: '',
      baseURL: '',
      azureOpenAIApiKey: '',
      azureOpenAIApiInstanceName: '',
      azureOpenAIApiDeploymentName: '',
      azureOpenAIApiVersion: '',
      // TODO: allow endpoint definitions from user
      // name: '',
      // TODO: add custom endpoint models defined by user
      // models: '',
    },
  });

  const [userKey, setUserKey] = useState('');
  const [expiresAtLabel, setExpiresAtLabel] = useState(EXPIRY.TWELVE_HOURS.label);
  const { getExpiry, saveUserKey } = useUserKey(endpoint);
  const { showToast } = useToastContext();
  const localize = useLocalize();

  const expirationOptions = Object.values(EXPIRY);
  const selectedExpiration = expirationOptions.find((option) => option.label === expiresAtLabel);

  /* === VIVENTIUM START ===
   * Feature: Secure cancellation for credential drafts.
   * Purpose: Escape, close, and explicit parent dismissal must discard unsaved secrets and reset
   * the retention choice. Saving still closes only after storage confirms success.
   */
  const resetForm = methods.reset;
  React.useEffect(() => {
    if (!open) {
      resetForm();
      setUserKey('');
      setExpiresAtLabel(EXPIRY.TWELVE_HOURS.label);
    }
  }, [open, resetForm]);
  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetForm();
      setUserKey('');
      setExpiresAtLabel(EXPIRY.TWELVE_HOURS.label);
    }
    onOpenChange(nextOpen);
  };
  /* === VIVENTIUM END === */

  const handleExpirationChange = (label: string) => {
    setExpiresAtLabel(label);
  };

  const submit = async () => {
    let expiresAt: number | null;

    if (selectedExpiration?.value === 0) {
      expiresAt = null;
    } else {
      expiresAt = Date.now() + (selectedExpiration ? selectedExpiration.value : 0);
    }

    const saveKey = async (key: string): Promise<boolean> => {
      try {
        /* === VIVENTIUM START ===
         * Feature: Recoverable Connected Accounts key save.
         * Purpose: Close and clear the dialog only after encrypted storage confirms success.
         */
        await saveUserKey(key, expiresAt);
        showToast({
          message: localize('com_ui_save_key_success'),
          status: NotificationSeverity.SUCCESS,
        });
        handleDialogOpenChange(false);
        return true;
        /* === VIVENTIUM END === */
      } catch (error) {
        logger.error('Error saving user key:', error);
        showToast({
          message: localize('com_ui_save_key_error'),
          status: NotificationSeverity.ERROR,
        });
        return false;
      }
    };

    if (formSet.has(endpoint) || formSet.has(endpointType ?? '')) {
      // TODO: handle other user provided options besides baseURL and apiKey
      await methods.handleSubmit(async (data) => {
        const isAzure = endpoint === EModelEndpoint.azureOpenAI;
        const isOpenAIBase =
          isAzure || endpoint === EModelEndpoint.openAI || isAssistantsEndpoint(endpoint);
        if (isAzure) {
          data.apiKey = 'n/a';
        }

        const emptyValues = Object.keys(data).filter((key) => {
          if (!isAzure && key.startsWith('azure')) {
            return false;
          }
          if (isOpenAIBase && key === 'baseURL') {
            return false;
          }
          if (key === 'baseURL' && !(userProvideURL ?? false)) {
            return false;
          }
          return data[key] === '';
        });

        if (emptyValues.length > 0) {
          showToast({
            message: 'The following fields are required: ' + emptyValues.join(', '),
            status: 'error',
          });
          onOpenChange(true);
          return;
        }

        const { apiKey, baseURL, ...azureOptions } = data;
        const userProvidedData = { apiKey, baseURL };
        if (isAzure) {
          userProvidedData.apiKey = JSON.stringify({
            azureOpenAIApiKey: azureOptions.azureOpenAIApiKey,
            azureOpenAIApiInstanceName: azureOptions.azureOpenAIApiInstanceName,
            azureOpenAIApiDeploymentName: azureOptions.azureOpenAIApiDeploymentName,
            azureOpenAIApiVersion: azureOptions.azureOpenAIApiVersion,
          });
        }

        if (await saveKey(JSON.stringify(userProvidedData))) {
          methods.reset();
        }
      })();
      return;
    }

    if (!userKey.trim()) {
      showToast({
        message: localize('com_ui_key_required'),
        status: NotificationSeverity.ERROR,
      });
      return;
    }

    if (await saveKey(userKey)) {
      setUserKey('');
    }
  };

  const EndpointComponent =
    endpointComponents[endpointType ?? endpoint] ?? endpointComponents['default'];
  const currentKeyExpiry = getExpiry();
  const selectedExpiryTime =
    selectedExpiration?.value === 0
      ? null
      : new Date(Date.now() + (selectedExpiration?.value ?? 0)).toLocaleString();

  return (
    <OGDialog open={open} onOpenChange={handleDialogOpenChange}>
      <OGDialogContent className="w-11/12 max-w-2xl">
        <OGDialogHeader>
          <OGDialogTitle>
            {`${localize('com_endpoint_config_key_for')} ${alternateName[endpoint] ?? endpoint}`}
          </OGDialogTitle>
        </OGDialogHeader>
        <div className="grid w-full items-center gap-2 py-4">
          <small className="text-red-600">
            {/* === VIVENTIUM START ===
             * UX truth: describe the retention policy being selected for this new key, not the
             * unrelated lifecycle of a currently saved key.
             * === VIVENTIUM END === */}
            {selectedExpiryTime === null
              ? localize('com_endpoint_config_key_never_expires')
              : `${localize('com_endpoint_config_key_encryption')} ${selectedExpiryTime}`}
          </small>
          <Dropdown
            label="Expires "
            value={expiresAtLabel}
            onChange={handleExpirationChange}
            options={expirationOptions.map((option) => option.label)}
            sizeClasses="w-[185px]"
            portal={false}
          />
          <div className="mt-2" />
          <FormProvider {...methods}>
            <EndpointComponent
              userKey={userKey}
              endpoint={endpoint}
              setUserKey={setUserKey}
              userProvideURL={userProvideURL}
            />
          </FormProvider>
          <HelpText endpoint={endpoint} />
        </div>
        <OGDialogFooter>
          <RevokeKeysButton
            endpoint={endpoint}
            disabled={!(currentKeyExpiry ?? '')}
            setDialogOpen={handleDialogOpenChange}
            removalMode={removalMode}
          />
          <Button variant="submit" onClick={() => void submit()}>
            {localize('com_ui_submit')}
          </Button>
        </OGDialogFooter>
      </OGDialogContent>
    </OGDialog>
  );
};

export default SetKeyDialog;
