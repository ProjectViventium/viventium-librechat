/* VIVENTIUM START: execute the actual startup failure handler without starting a server. */
const fs = require('node:fs');
const parser = require('@babel/parser');

function startupFailureHandler() {
  const source = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  const ast = parser.parse(source, { sourceType: 'unambiguous' });
  let handler;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CatchClause' && node.param?.name === 'startupError') handler = node.body;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  if (!handler) throw new Error('Required runtime startup handler missing');
  return new Function(
    'upgradeFinalization',
    'logger',
    'process',
    'startupError',
    source.slice(handler.start + 1, handler.end - 1),
  );
}

test.each(['fetch failed', 'operation aborted', '@librechat/agents failure'])(
  'required startup %s exits nonzero instead of leaving a listener without recovery',
  (message) => {
    const exit = jest.fn((code) => {
      throw Object.assign(new Error('simulated exit'), { exitCode: code });
    });
    expect(() =>
      startupFailureHandler()(
        { isArmed: () => false },
        { error: jest.fn() },
        { exit },
        new Error(message),
      ),
    ).toThrow('simulated exit');
    expect(exit).toHaveBeenCalledWith(1);
  },
);
/* VIVENTIUM END */
