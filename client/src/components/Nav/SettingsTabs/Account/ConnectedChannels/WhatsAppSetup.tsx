/**
 * === VIVENTIUM START ===
 * Feature: Connected Channels administration.
 * Purpose: Guide official WhatsApp Cloud API setup through a server-owned HTTPS boundary.
 * === VIVENTIUM END ===
 */

import { useState } from 'react';
import type { WhatsAppChannelConnectRequest } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { SetupActions, SetupField, SetupPanel } from './SetupField';

const EMPTY_FORM = {
  publicBaseUrl: '',
  phoneNumberId: '',
  businessAccountId: '',
  accessToken: '',
  appSecret: '',
  verifyToken: '',
};

export default function WhatsAppSetup({
  isSubmitting,
  onCancel,
  onSubmit,
}: {
  isSubmitting: boolean;
  onCancel: () => void;
  onSubmit: (input: WhatsAppChannelConnectRequest) => void;
}) {
  const localize = useLocalize();
  const [form, setForm] = useState(EMPTY_FORM);
  const updateField = (field: keyof typeof EMPTY_FORM, value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  return (
    <SetupPanel>
      <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
        {localize('com_ui_connected_channels_whatsapp_https_required')}
      </p>
      <p className="text-xs text-text-secondary">
        {localize('com_ui_connected_channels_whatsapp_instructions')}
      </p>
      <a
        href="https://github.com/ProjectViventium/viventium/blob/main/docs/requirements_and_learnings/47_Remote_Access_and_Tunneling.md"
        target="_blank"
        rel="noreferrer"
        className="inline-flex text-sm font-medium text-primary hover:underline"
      >
        {localize('com_ui_connected_channels_whatsapp_open_https_guide')}
      </a>
      <a
        href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
        target="_blank"
        rel="noreferrer"
        className="inline-flex text-sm font-medium text-primary hover:underline"
      >
        {localize('com_ui_connected_channels_whatsapp_open_meta')}
      </a>
      <form
        aria-label={localize('com_ui_connected_channels_setup_form', {
          provider: localize('com_ui_connected_channels_whatsapp'),
        })}
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const input = Object.fromEntries(
            Object.entries(form).map(([key, value]) => [key, value.trim()]),
          ) as typeof EMPTY_FORM;
          onSubmit({ channel: 'whatsapp', ...input });
        }}
      >
        <SetupField
          name="whatsappPublicBaseUrl"
          value={form.publicBaseUrl}
          label={localize('com_ui_connected_channels_whatsapp_public_base_url')}
          placeholder="https://api.example.com"
          onChange={(event) => updateField('publicBaseUrl', event.target.value)}
        />
        <SetupField
          required
          name="whatsappPhoneNumberId"
          value={form.phoneNumberId}
          label={localize('com_ui_connected_channels_whatsapp_phone_number_id')}
          onChange={(event) => updateField('phoneNumberId', event.target.value)}
        />
        <SetupField
          required
          name="whatsappBusinessAccountId"
          value={form.businessAccountId}
          label={localize('com_ui_connected_channels_whatsapp_business_account_id')}
          onChange={(event) => updateField('businessAccountId', event.target.value)}
        />
        <SetupField
          required
          type="password"
          name="whatsappAccessToken"
          value={form.accessToken}
          label={localize('com_ui_connected_channels_whatsapp_access_token')}
          onChange={(event) => updateField('accessToken', event.target.value)}
        />
        <SetupField
          required
          type="password"
          name="whatsappAppSecret"
          value={form.appSecret}
          label={localize('com_ui_connected_channels_whatsapp_app_secret')}
          onChange={(event) => updateField('appSecret', event.target.value)}
        />
        <SetupField
          required
          type="password"
          name="whatsappVerifyToken"
          value={form.verifyToken}
          label={localize('com_ui_connected_channels_whatsapp_verify_token')}
          onChange={(event) => updateField('verifyToken', event.target.value)}
        />
        <SetupActions isSubmitting={isSubmitting} onCancel={onCancel} />
      </form>
    </SetupPanel>
  );
}
