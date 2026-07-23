/**
 * === VIVENTIUM START ===
 * Feature: Slack Socket Mode setup.
 * Purpose: Provide a copyable least-privilege manifest without requiring a public Slack event URL.
 * === VIVENTIUM END ===
 */

export const SLACK_SOCKET_MODE_MANIFEST = Object.freeze({
  display_information: {
    name: 'Viventium',
    description: 'Connect Slack conversations to your local Viventium runtime.',
  },
  features: {
    bot_user: {
      display_name: 'Viventium',
      always_online: false,
    },
  },
  oauth_config: {
    scopes: {
      bot: ['app_mentions:read', 'chat:write', 'im:history'],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: ['app_mention', 'message.im'],
    },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
});
