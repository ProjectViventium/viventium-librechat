const { attachViventiumExtensions } = require('./app');

describe('Config app Viventium extension preservation', () => {
  test('keeps Viventium YAML extensions available at req.config.viventium', () => {
    const rawConfig = {
      viventium: {
        background_cortices: {
          activation_format: { brew_begin_tag: '<!--viv_internal:brew_begin-->' },
          activation_policy: {
            enabled: true,
            prompt: 'Background agents are optional reviewers, not controllers.',
          },
        },
        no_response: {
          prompt: 'Return {NTA} when there is nothing useful to add.',
        },
      },
    };

    const appConfig = attachViventiumExtensions(
      {
        config: rawConfig,
        endpoints: { agents: {} },
      },
      rawConfig,
    );

    expect(appConfig.viventium).toBe(rawConfig.viventium);
    expect(appConfig.viventium.background_cortices.activation_policy.enabled).toBe(true);
    expect(appConfig.viventium.no_response.prompt).toContain('{NTA}');
  });

  test('does not invent a Viventium block when the YAML has none', () => {
    const appConfig = attachViventiumExtensions({ endpoints: { agents: {} } }, {});

    expect(appConfig).toEqual({ endpoints: { agents: {} } });
  });
});
