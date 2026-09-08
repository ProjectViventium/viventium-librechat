const express = require('express');
const request = require('supertest');

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    if (!req.headers['x-test-role']) {
      return res.sendStatus(401);
    }
    req.user = { id: 'synthetic-owner', role: req.headers['x-test-role'] };
    return next();
  },
  checkAdmin: (req, res, next) => (req.user.role === 'ADMIN' ? next() : res.sendStatus(403)),
}));
jest.mock('@librechat/api', () => ({ runLifeSetup: jest.fn() }));
const { runLifeSetup } = require('@librechat/api');
const state = {
  version: 1,
  enabled: false,
  folderConfigured: false,
  folderChoiceLocation: 'mac',
  connector: 'none',
  intent: null,
};

function app() {
  const instance = express();
  instance.use('/api/viventium/life', require('../life'));
  return instance;
}

beforeEach(() => {
  runLifeSetup.mockReset();
  runLifeSetup.mockResolvedValue(state);
});

test('only the owner can read or change LIFE intent', async () => {
  expect((await request(app()).get('/api/viventium/life/setup')).status).toBe(401);
  expect(
    (await request(app()).get('/api/viventium/life/setup').set('x-test-role', 'USER')).status,
  ).toBe(403);
  expect(
    (
      await request(app())
        .post('/api/viventium/life/intent')
        .set('x-test-role', 'USER')
        .send({ text: 'x' })
    ).status,
  ).toBe(403);
  expect(runLifeSetup).not.toHaveBeenCalled();
});

test('read, save, clear and disable use the same owner and preserve exact words', async () => {
  const agent = request(app());
  expect((await agent.get('/api/viventium/life/setup').set('x-test-role', 'ADMIN')).body).toEqual(
    state,
  );
  await agent
    .post('/api/viventium/life/intent')
    .set('x-test-role', 'ADMIN')
    .send({ text: '  My exact words.  ' });
  expect(runLifeSetup).toHaveBeenCalledWith('save', '  My exact words.  ');
  await agent.delete('/api/viventium/life/intent').set('x-test-role', 'ADMIN');
  expect(runLifeSetup).toHaveBeenCalledWith('clear', undefined);
  await agent
    .post('/api/viventium/life/setup')
    .set('x-test-role', 'ADMIN')
    .send({ enabled: false });
  expect(runLifeSetup).toHaveBeenCalledWith('disable', undefined);
});

test('remote requests cannot choose folders or inject paths and arguments', async () => {
  for (const body of [
    { text: 'x', folders: ['/synthetic/private'] },
    { text: 'x', folder: '/synthetic/private' },
    { text: '' },
  ]) {
    expect(
      (
        await request(app())
          .post('/api/viventium/life/intent')
          .set('x-test-role', 'ADMIN')
          .send(body)
      ).status,
    ).toBe(400);
  }
  expect(runLifeSetup).not.toHaveBeenCalled();
});

test('owner failure gives one safe recovery action without private diagnostics', async () => {
  runLifeSetup.mockRejectedValue(new Error('private path /synthetic/private'));
  const result = await request(app()).get('/api/viventium/life/setup').set('x-test-role', 'ADMIN');
  expect(result.status).toBe(409);
  expect(result.text).not.toContain('/synthetic/private');
  expect(result.body.message).toContain('Open Life on your Mac');
});
