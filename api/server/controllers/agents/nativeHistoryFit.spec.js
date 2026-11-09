const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

// Exercise the real buildMessages callback at its native estimator and Core-store boundaries.
function fitOwner({ peerBytes = 90000, capacity = 145000, nativeBudget = 237500 } = {}) {
  const file = path.join(__dirname, 'client.js');
  const ast = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let callback;
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'canCarryWholeHistory')
      callback = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!callback) throw new Error('Native history fit owner not found');
  const resolveLegacyOutputCarrier = jest.fn(async () =>
    peerBytes == null ? null : { reservedContextUtf8Bytes: peerBytes },
  );
  const nativeWholeHistoryFits = jest.fn((_req, _agent, _rows, reserved) => reserved <= capacity);
  const scope = {
    module: { exports: {} },
    Buffer,
    req: {},
    nativeUploadRequestBody: {},
    nativeReplayBudget: nativeBudget,
    NATIVE_MAIN_TURN_CONTEXT_MAX_BYTES: 128 * 1024,
    TURN_CONTEXT_SEPARATOR_BYTES: 2,
    conversationProviderUsesNativeBody: () => true,
    resolveConversationProviderUploadedFiles: async () => [],
    resolveLegacyOutputCarrier,
    nativeWholeHistoryFits,
    isAgentsEndpoint: () => true,
    logger: { info: jest.fn() },
  };
  vm.runInNewContext(`module.exports=function(){return (${callback.getText(ast)});};`, scope);
  const run = scope.module.exports.call({ options: { agent: {}, endpoint: 'agents' } });
  return { run, resolveLegacyOutputCarrier, nativeWholeHistoryFits };
}

test('does not defer legacy repair when full Core and reviewed conversation exceed native remaining space', async () => {
  const owner = fitOwner();
  const source = [{ messageId: 'current', text: 'Keep this source intact.' }];
  const capsule = 'Reviewed historical facts. '.repeat(2200);
  expect(await owner.run(source, capsule)).toBe(false);
  expect(owner.nativeWholeHistoryFits.mock.calls[0][2]).toBe(source);
  expect(owner.nativeWholeHistoryFits.mock.calls[0][3]).toBeGreaterThan(145000);
});

test('retains the conservative native floor for a small fitting pair', async () => {
  const owner = fitOwner({ peerBytes: 20000 });
  expect(await owner.run([], 'Small reviewed capsule.')).toBe(true);
  expect(owner.nativeWholeHistoryFits.mock.calls[0][3]).toBe(128 * 1024);
});

test('cannot assert positive fit when the mandatory Core allocation is unavailable', async () => {
  const owner = fitOwner({ peerBytes: null });
  expect(await owner.run([], 'Reviewed capsule.')).toBe(false);
  expect(owner.nativeWholeHistoryFits).not.toHaveBeenCalled();
});

test('retains actual peer pricing for the unknown native-budget path', async () => {
  const owner = fitOwner({ peerBytes: 20000, nativeBudget: null });
  const capsule = 'Quoted "evidence"\nwith a new line.';
  expect(await owner.run([], capsule)).toBe(true);
  expect(owner.nativeWholeHistoryFits.mock.calls[0][3]).toBe(
    20000 + Buffer.byteLength(JSON.stringify(capsule)) + 2,
  );
});
