// VIVENTIUM START — Browser-only compatibility adapter derived from html-parse-stringify.
// Attribution and exact upstream legal records: ./htmlAstAdapter.NOTICE.md
type Attributes = Record<string, string>;

export type HtmlAstNode =
  | { type: 'text'; content: string }
  | { type: 'comment'; comment: string }
  | {
      type: 'tag' | 'component';
      name: string;
      attrs: Attributes;
      voidElement: boolean;
      children: HtmlAstNode[];
    };

const voidElements = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'command',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function findTagEnd(input: string, start: number) {
  if (input.startsWith('<!--', start)) {
    const commentEnd = input.indexOf('-->', start + 4);
    return commentEnd < 0 ? input.length - 1 : commentEnd + 2;
  }

  let quote: string | null = null;
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseAttributes(source: string): Attributes {
  const attrs: Attributes = {};
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (index >= source.length || source[index] === '/') break;

    const keyStart = index;
    while (index < source.length && !/[\s=/]/.test(source[index])) index += 1;
    const key = source.slice(keyStart, index);
    while (/\s/.test(source[index] ?? '')) index += 1;

    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] ?? '')) index += 1;
      const quote = source[index] === '"' || source[index] === "'" ? source[index++] : null;
      const valueStart = index;
      if (quote) {
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        while (index < source.length && !/[\s/]/.test(source[index])) index += 1;
        value = source.slice(valueStart, index);
      }
    }
    if (key) attrs[key] = value;
  }
  return attrs;
}

function parseTag(token: string, components: Record<string, unknown>): HtmlAstNode {
  if (token.startsWith('<!--')) {
    const end = token.endsWith('-->') ? -3 : token.length;
    return { type: 'comment', comment: token.slice(4, end) };
  }

  const inner = token.slice(1, -1).trim();
  const selfClosing = /\/\s*$/.test(inner);
  const normalized = selfClosing ? inner.replace(/\/\s*$/, '').trimEnd() : inner;
  const nameEnd = normalized.search(/\s/);
  const name = nameEnd < 0 ? normalized : normalized.slice(0, nameEnd);
  const attrsSource = nameEnd < 0 ? '' : normalized.slice(nameEnd + 1);
  return {
    type: Object.hasOwn(components, name) ? 'component' : 'tag',
    name,
    attrs: parseAttributes(attrsSource),
    voidElement: selfClosing || voidElements.has(name),
    children: [],
  };
}

function appendText(destination: HtmlAstNode[], text: string, normalizeWhitespace: boolean) {
  if (!text) return;
  destination.push({
    type: 'text',
    content: normalizeWhitespace && /^\s+$/.test(text) ? ' ' : text,
  });
}

export function parse(
  input: string,
  options: { components?: Record<string, unknown> } = {},
): HtmlAstNode[] {
  const roots: HtmlAstNode[] = [];
  const stack: Extract<HtmlAstNode, { children: HtmlAstNode[] }>[] = [];
  const components = options.components ?? {};
  let cursor = 0;
  let normalizeWhitespace = false;

  while (cursor < input.length) {
    const tagStart = input.indexOf('<', cursor);
    const destination = stack.at(-1)?.children ?? roots;
    if (tagStart < 0) {
      appendText(destination, input.slice(cursor), normalizeWhitespace);
      break;
    }
    appendText(destination, input.slice(cursor, tagStart), normalizeWhitespace);

    const tagEnd = findTagEnd(input, tagStart);
    if (tagEnd < 0) {
      appendText(destination, input.slice(tagStart), normalizeWhitespace);
      break;
    }
    const token = input.slice(tagStart, tagEnd + 1);
    if (token.startsWith('</')) {
      const closingName = token.slice(2, -1).trim();
      if (stack.at(-1)?.name === closingName) stack.pop();
      normalizeWhitespace = true;
    } else {
      const node = parseTag(token, components);
      destination.push(node);
      if ('children' in node && !node.voidElement && node.type === 'component') {
        const closingToken = `</${node.name}>`;
        const closingStart = input.indexOf(closingToken, tagEnd + 1);
        cursor = closingStart < 0 ? tagEnd + 1 : closingStart + closingToken.length;
        normalizeWhitespace = true;
        continue;
      }
      if ('children' in node && !node.voidElement) stack.push(node);
      normalizeWhitespace = 'voidElement' in node && node.voidElement;
    }
    cursor = tagEnd + 1;
  }

  return roots;
}

function stringifyNode(node: HtmlAstNode): string {
  if (node.type === 'text') return node.content;
  if (node.type === 'comment') return `<!--${node.comment}-->`;
  const attrs = Object.entries(node.attrs)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  const opening = `<${node.name}${attrs ? ` ${attrs}` : ''}${node.voidElement ? '/' : ''}>`;
  return node.voidElement
    ? opening
    : `${opening}${node.children.map(stringifyNode).join('')}</${node.name}>`;
}

export function stringify(ast: HtmlAstNode[]) {
  return ast.map(stringifyNode).join('');
}

export default { parse, stringify };
// VIVENTIUM END
