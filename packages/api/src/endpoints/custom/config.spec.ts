import { loadCustomEndpointsConfig } from './config';
/* === VIVENTIUM START === Public controls follow the actual transport omission contract. === */
it('projects dropParams without exposing endpoint secrets', () => {
  const config = loadCustomEndpointsConfig([
    {
      name: 'synthetic',
      baseURL: 'https://api.example/v1',
      apiKey: 'synthetic-secret',
      models: { default: ['model'] },
      dropParams: ['temperature', 'top_p'],
    },
  ] as never);
  expect(config?.synthetic?.dropParams).toEqual(['temperature', 'top_p']);
  expect(config?.synthetic).not.toHaveProperty('apiKey');
  expect(config?.synthetic).not.toHaveProperty('baseURL');
});
/* === VIVENTIUM END === */
