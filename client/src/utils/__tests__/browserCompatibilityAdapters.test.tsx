import { act, render, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import HTML, { parse, stringify } from '../htmlAstAdapter';
import { lockAttribute, RemoveScrollBar } from '../scrollBarAdapter';
import useComposedRef from '../useComposedRefAdapter';

const upstreamHTML = jest.requireActual('html-parse-stringify');

describe('browser compatibility adapters', () => {
  it('preserves syntax highlighting through the maintained rehype upgrade', () => {
    const { container } = render(
      <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
        {'```js\nconst answer = 42;\n```'}
      </ReactMarkdown>,
    );
    expect(container.querySelector('code')).toHaveClass('hljs', 'language-js');
    expect(container.querySelector('.hljs-keyword')).toHaveTextContent('const');
  });

  describe('HTML AST adapter', () => {
    it.each([
      '<0>Hello <1>world</1></0>',
      '<0>Line<br/>end</0>',
      '<0><strong title="hello world">value</strong></0>',
      '<0><!--synthetic comment--><BR>after</0>',
      'leading <0>value</0> trailing',
      '<0>\n  <1>nested</1>\n</0>',
      "<0 class='synthetic' disabled>attributes</0>",
      '<0><img alt="synthetic > fixture"/></0>',
      '<0><1/></0>',
      '<0>one  two &amp; three</0>',
      '<0><strong><em>deep</em></strong></0>',
    ])('matches the prior parser for the translated-markup corpus: %s', (fixture) => {
      expect(parse(fixture)).toEqual(upstreamHTML.parse(fixture));
      expect(stringify(parse(fixture))).toBe(upstreamHTML.stringify(upstreamHTML.parse(fixture)));
      expect(HTML.parse(fixture)).toEqual(parse(fixture));
    });

    it('preserves the component option by intentionally omitting owned child markup', () => {
      const fixture = '<0>before<Owned>private child</Owned>after</0>';
      const options = { components: { Owned: true } };
      expect(parse(fixture, options)).toEqual(upstreamHTML.parse(fixture, options));
    });

    it('treats an unterminated tag as text instead of looping or dropping input', () => {
      const fixture = '<0 title="unterminated>synthetic';
      expect(parse(fixture)).toEqual([{ type: 'text', content: fixture }]);
    });
  });

  describe('composed ref adapter', () => {
    it('updates internal and object refs with the same node', () => {
      const internalRef = createRef<HTMLTextAreaElement>();
      const externalRef = createRef<HTMLTextAreaElement>();
      const textarea = document.createElement('textarea');
      const { result } = renderHook(() => useComposedRef(internalRef, externalRef));

      act(() => result.current(textarea));
      expect(internalRef.current).toBe(textarea);
      expect(externalRef.current).toBe(textarea);

      act(() => result.current(null));
      expect(internalRef.current).toBeNull();
      expect(externalRef.current).toBeNull();
    });

    it('supports callback refs', () => {
      const internalRef = createRef<HTMLTextAreaElement>();
      const externalRef = jest.fn();
      const textarea = document.createElement('textarea');
      const { result } = renderHook(() => useComposedRef(internalRef, externalRef));

      act(() => result.current(textarea));
      expect(externalRef).toHaveBeenLastCalledWith(textarea);
    });
  });

  describe('scroll-lock adapter', () => {
    it('installs one lock stylesheet and reference-counts nested locks', () => {
      const first = render(<RemoveScrollBar />);
      expect(document.body.getAttribute(lockAttribute)).toBe('1');
      expect(document.head.querySelectorAll('style[data-viventium-scroll-lock]')).toHaveLength(1);

      const second = render(<RemoveScrollBar gapMode="padding" />);
      expect(document.body.getAttribute(lockAttribute)).toBe('2');
      expect(document.head.querySelectorAll('style[data-viventium-scroll-lock]')).toHaveLength(1);

      second.unmount();
      expect(document.body.getAttribute(lockAttribute)).toBe('1');
      first.unmount();
      expect(document.body.hasAttribute(lockAttribute)).toBe(false);
      expect(document.head.querySelector('style[data-viventium-scroll-lock]')).toBeNull();
    });
  });
});
