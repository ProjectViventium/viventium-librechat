import { resolveAppLink } from '../appLinks';

describe('links to the configured installation', () => {
  it.each([
    ['http://localhost:7190', 'http://127.0.0.1:7190'],
    ['https://chat.example.test', 'https://workspace.example.test'],
  ])(
    'keeps the current session when the installation is accessed through an alias',
    (canonical, active) => {
      expect(
        resolveAppLink(`${canonical}/prefix/c/history?view=source#turn`, canonical, active),
      ).toBe(`${active}/prefix/c/history?view=source#turn`);
    },
  );

  it.each([
    '/c/history',
    'https://outside.example.test/c/history',
    'http://localhost:3190/c/history',
    'http://localhost:7190.evil.test/c/history',
    'http://user:password@localhost:7190/c/history',
    'javascript:alert(1)',
    'not a URL',
  ])('leaves unrelated or non-absolute URLs to the existing renderer: %s', (href) => {
    expect(resolveAppLink(href, 'http://localhost:7190', 'http://127.0.0.1:7190')).toBe(href);
  });

  it('does not guess installation identity or rewrite an already matching origin', () => {
    const href = 'https://chat.example.test/c/history';
    expect(resolveAppLink(href, undefined, 'https://alias.example.test')).toBe(href);
    expect(resolveAppLink(href, 'invalid', 'https://alias.example.test')).toBe(href);
    expect(resolveAppLink(href, 'https://chat.example.test', 'file:///tmp/page')).toBe(href);
    expect(resolveAppLink(href, 'https://chat.example.test', 'https://chat.example.test')).toBe(
      href,
    );
  });
});
