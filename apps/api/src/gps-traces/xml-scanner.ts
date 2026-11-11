// A strict, minimal XML tokenizer shared by the GPX readers (the D10 trace tools and the activity import, ADR-0086).
// It is intentionally not a general XML parser:
//  - a DOCTYPE, an entity declaration and every other markup declaration (`<!` that is not a comment or CDATA) is
//    refused, so there is nothing to expand and no external resource to fetch: nothing here ever opens a URL or a file;
//  - entity and character references are never expanded: text and attribute values are passed on exactly as written,
//    so a reader that needs a number or an instant simply fails to parse a value that contains one;
//  - tags must nest and close; text outside the root element is refused.
// Callers decide which elements mean anything; everything else is skipped and never stored.
//
// The reader runs on uploaded files on the request thread, so it must stay linear in the size of its input. It reads
// with one cursor that only moves forward: every step either consumes at least one character or refuses the document
// at the position where it stopped making sense. There are no regular expressions over unbounded input in the tag
// path (an unanchored attribute regex once rescanned every suffix of `<gpx xxxx…>`, which was quadratic).

export type XmlScanFailure = 'declaration' | 'malformed' | 'not_xml';

export interface XmlScanHandlers {
  /**
   * Attribute names are qualified, exactly as written (`xmlns:gpx`, `lat`). `attributes` is a new map for this tag that
   * the tokenizer never reads again, so the handler may change it (the namespace layer removes what it consumes).
   */
  startElement(qualifiedName: string, attributes: Map<string, string>): void;
  endElement(qualifiedName: string): void;
  /** Character data between tags and the content of CDATA sections, in document order. */
  text(chunk: string): void;
}

/** Called with a complete, human-readable message that never quotes the document. Must throw. */
export type XmlScanFail = (kind: XmlScanFailure, message: string) => never;

// Anchored on the literal `<!`, so each position is tested in constant time.
const DECLARATION = /<!DOCTYPE|<!ENTITY|<!\[(?!CDATA\[)/iu;

export const DECLARATION_MESSAGE =
  'The file declares a DOCTYPE or entities; DTDs are not supported, export a plain GPX file';

export function localName(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);
}

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const SLASH = 0x2f;
const LESS_THAN = 0x3c;
const EQUALS = 0x3d;
const GREATER_THAN = 0x3e;

/** XML whitespace (S): space, tab, carriage return, line feed. */
const isWhitespace = (code: number) => code === SPACE || code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN;

/** Characters that end a name inside a tag. Everything else is part of the name; the namespace layer checks colons. */
const endsName = (code: number) =>
  isWhitespace(code) ||
  code === SLASH ||
  code === GREATER_THAN ||
  code === EQUALS ||
  code === DOUBLE_QUOTE ||
  code === SINGLE_QUOTE ||
  code === LESS_THAN;

export function scanXml(text: string, handlers: XmlScanHandlers, fail: XmlScanFail): void {
  const malformed = (detail: string): never => fail('malformed', `The file is malformed XML: ${detail}`);
  if (DECLARATION.test(text)) {
    fail('declaration', DECLARATION_MESSAGE);
  }
  const length = text.length;

  /** The index after the name that starts at `from` (equal to `from` when there is none). */
  const nameEnd = (from: number): number => {
    let index = from;
    while (index < length && !endsName(text.charCodeAt(index))) index += 1;
    return index;
  };
  const skipWhitespace = (from: number): number => {
    let index = from;
    while (index < length && isWhitespace(text.charCodeAt(index))) index += 1;
    return index;
  };
  const unterminatedTag = (): never => malformed('an unterminated tag');

  /** Reads a closing tag whose `</` starts at `open`; returns the index after its `>`. */
  const closingTag = (open: number, stack: string[]): number => {
    const nameStart = open + 2;
    const end = nameEnd(nameStart);
    if (end === nameStart) {
      if (end >= length) unterminatedTag();
      malformed('a closing tag has no name');
    }
    const qualifiedName = text.slice(nameStart, end);
    const close = skipWhitespace(end);
    if (close >= length) unterminatedTag();
    if (text.charCodeAt(close) !== GREATER_THAN) malformed('a closing tag has something after its name');
    if (stack.pop() !== qualifiedName) malformed('a closing tag does not match its opening tag');
    handlers.endElement(qualifiedName);
    return close + 1;
  };

  /** Reads a start or empty-element tag whose `<` is at `open`; returns the index after its `>`. */
  const startTag = (open: number, stack: string[]): number => {
    const nameStart = open + 1;
    let index = nameEnd(nameStart);
    if (index === nameStart) {
      if (index >= length) unterminatedTag();
      malformed('an element has no name');
    }
    const qualifiedName = text.slice(nameStart, index);
    const attributes = new Map<string, string>();
    for (;;) {
      const separated = index;
      index = skipWhitespace(index);
      if (index >= length) unterminatedTag();
      const code = text.charCodeAt(index);
      if (code === GREATER_THAN) {
        stack.push(qualifiedName);
        handlers.startElement(qualifiedName, attributes);
        return index + 1;
      }
      if (code === SLASH) {
        if (index + 1 >= length) unterminatedTag();
        if (text.charCodeAt(index + 1) !== GREATER_THAN) malformed('a "/" in a tag is not followed by ">"');
        handlers.startElement(qualifiedName, attributes);
        handlers.endElement(qualifiedName);
        return index + 2;
      }
      // An attribute: whitespace, a name, optional whitespace, "=", optional whitespace, a quoted value.
      if (index === separated) malformed('attributes are not separated by whitespace');
      const attributeStart = index;
      index = nameEnd(index);
      if (index === attributeStart) malformed('an element has an attribute that is not name="value"');
      const attributeName = text.slice(attributeStart, index);
      index = skipWhitespace(index);
      if (index >= length) unterminatedTag();
      if (text.charCodeAt(index) !== EQUALS) malformed('an element has an attribute that is not name="value"');
      index = skipWhitespace(index + 1);
      if (index >= length) unterminatedTag();
      const quote = text.charCodeAt(index);
      if (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE) malformed('an attribute value is not quoted');
      const valueEnd = text.indexOf(quote === DOUBLE_QUOTE ? '"' : "'", index + 1);
      if (valueEnd === -1) malformed('an attribute value is never closed');
      if (attributes.has(attributeName)) malformed('an element repeats an attribute');
      attributes.set(attributeName, text.slice(index + 1, valueEnd));
      index = valueEnd + 1;
    }
  };

  const stack: string[] = [];
  let sawElement = false;
  let position = 0;
  while (position < length) {
    const open = text.indexOf('<', position);
    if (open === -1) {
      if (text.slice(position).trim() !== '') {
        malformed('text outside the root element');
      }
      break;
    }
    if (open > position) {
      const chunk = text.slice(position, open);
      if (stack.length === 0 && chunk.trim() !== '') {
        malformed('text outside the root element');
      }
      handlers.text(chunk);
    }
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end === -1) {
        malformed('an unterminated comment');
      }
      position = end + 3;
    } else if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      if (end === -1) {
        malformed('an unterminated CDATA section');
      }
      handlers.text(text.slice(open + 9, end));
      position = end + 3;
    } else if (text.startsWith('<!', open)) {
      fail('declaration', DECLARATION_MESSAGE);
    } else if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      if (end === -1) {
        malformed('an unterminated processing instruction');
      }
      position = end + 2;
    } else if (text.startsWith('</', open)) {
      position = closingTag(open, stack);
    } else {
      if (stack.length === 0 && sawElement) {
        malformed('more than one root element');
      }
      sawElement = true;
      position = startTag(open, stack);
    }
  }

  if (!sawElement) {
    fail('not_xml', 'The file is not XML (expected a GPX document); it may be empty or in another format');
  }
  if (stack.length !== 0) {
    malformed('an element is never closed');
  }
}

// Namespaces in XML 1.0 on top of the tokenizer. A reader that identifies elements by namespace URI and local name uses
// this instead of `localName()`, so an element in a foreign namespace, or one with an undeclared prefix, never passes
// for a GPX element.

export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

export interface ExpandedName {
  /** The namespace URI, or null for an element in no namespace. */
  readonly namespace: string | null;
  readonly localName: string;
}

export interface NamespacedXmlHandlers {
  /**
   * `attributes` holds the attributes in no namespace (unprefixed, not `xmlns`), by name. Namespace declarations and
   * prefixed attributes are validated and resolved but not passed on.
   */
  startElement(name: ExpandedName, attributes: ReadonlyMap<string, string>): void;
  /** The name as resolved at the matching start tag. */
  endElement(name: ExpandedName): void;
  text(chunk: string): void;
}

/**
 * One namespace URI, shared by every binding to an equal URI that is in scope or shadowed. `id` identifies the URI
 * while it is interned, so the duplicate-attribute check never copies, hashes or compares the URI itself.
 */
interface InternedNamespace {
  readonly id: number;
  readonly uri: string;
  /** Bindings (in scope or shadowed) that refer to this entry; it is forgotten at zero. */
  references: number;
}

/** One namespace binding that an element's declarations replaced, restored when the element closes. */
interface Shadowed {
  readonly prefix: string;
  readonly previous: InternedNamespace | undefined;
}

/**
 * Scans `text` like `scanXml` and resolves every element and attribute name: inherited bindings, `xmlns=""` to
 * undeclare the default namespace, and the previous bindings restored when an element closes. Refuses as malformed an
 * undeclared prefix, a QName with an empty part or more than one colon, an empty prefix binding (`xmlns:p=""`), a
 * misuse of the reserved `xml` and `xmlns` prefixes or namespaces, and two attributes with the same expanded name.
 *
 * Its bookkeeping stays linear in time and memory, whatever the URIs: a namespace URI is a slice of the document that
 * is hashed and compared only when it is declared (interned into a numbered entry), never per use, so a megabyte URI
 * shared by many attributes or elements costs nothing more per use. An entry is forgotten when the last binding to it
 * goes out of scope, each binding change is undone in constant time, and an open element costs three array slots.
 */
export function scanNamespacedXml(text: string, handlers: NamespacedXmlHandlers, fail: XmlScanFail): void {
  const malformed = (detail: string): never => fail('malformed', `The file is malformed XML: ${detail}`);

  const interned = new Map<string, InternedNamespace>();
  let nextNamespaceId = 0;
  const acquire = (uri: string): InternedNamespace => {
    let entry = interned.get(uri);
    if (entry === undefined) {
      entry = { id: nextNamespaceId, references: 0, uri };
      nextNamespaceId += 1;
      interned.set(uri, entry);
    }
    entry.references += 1;
    return entry;
  };
  const release = (entry: InternedNamespace | undefined): void => {
    if (entry === undefined) return;
    entry.references -= 1;
    // `entry.uri` is the very string used as the key, so the lookup does not compare URI contents.
    if (entry.references === 0) interned.delete(entry.uri);
  };

  // The key '' is the default namespace; '' as a URI never occurs for a prefix (refused) and means "undeclared" for the
  // default namespace, which is stored as a missing key.
  const bindings = new Map<string, InternedNamespace>([['xml', acquire(XML_NAMESPACE)]]);
  // The open elements, innermost last: their resolved names, and where each one's entries in `undo` start.
  const openNamespaces: (string | null)[] = [];
  const openLocalNames: string[] = [];
  const undoMarks: number[] = [];
  const undo: Shadowed[] = [];

  /** Splits a QName into prefix ('' when none) and local part, refusing anything that is not a QName. */
  const splitQName = (qualifiedName: string): readonly [string, string] => {
    const colon = qualifiedName.indexOf(':');
    if (colon === -1) return ['', qualifiedName];
    if (colon === 0 || colon === qualifiedName.length - 1 || qualifiedName.includes(':', colon + 1)) {
      malformed('a name is not a valid qualified name');
    }
    return [qualifiedName.slice(0, colon), qualifiedName.slice(colon + 1)];
  };

  const resolvePrefix = (prefix: string): InternedNamespace => {
    if (prefix === 'xmlns') malformed('the reserved prefix xmlns is used on an element or attribute name');
    const entry = bindings.get(prefix);
    if (entry === undefined) malformed('an element or attribute uses an undeclared namespace prefix');
    return entry as InternedNamespace;
  };

  const declare = (prefix: string, namespace: string): void => {
    if (prefix === 'xmlns') malformed('the reserved prefix xmlns is declared');
    if (prefix === 'xml' ? namespace !== XML_NAMESPACE : namespace === XML_NAMESPACE) {
      malformed('the reserved prefix xml is bound to another namespace, or its namespace to another prefix');
    }
    if (namespace === XMLNS_NAMESPACE) malformed('the reserved xmlns namespace is declared');
    if (prefix !== '' && namespace === '') malformed('a namespace prefix is bound to an empty name');
    // The replaced binding stays referenced while it is shadowed; it is restored, not re-interned, at the end tag.
    undo.push({ prefix, previous: bindings.get(prefix) });
    if (namespace === '') bindings.delete(prefix);
    else bindings.set(prefix, acquire(namespace));
  };

  scanXml(
    text,
    {
      endElement: () => {
        const mark = undoMarks.pop() as number;
        while (undo.length > mark) {
          const { prefix, previous } = undo.pop() as Shadowed;
          release(bindings.get(prefix));
          if (previous === undefined) bindings.delete(prefix);
          else bindings.set(prefix, previous);
        }
        handlers.endElement({ localName: openLocalNames.pop() as string, namespace: openNamespaces.pop() as string | null });
      },
      startElement: (qualifiedName, attributes) => {
        // Declarations first: they apply to the element's own name and to its other attributes. Each one is removed
        // from `attributes` once read, as is each prefixed attribute below, so what is left is passed on as is.
        undoMarks.push(undo.length);
        for (const [attributeName, value] of attributes) {
          if (attributeName === 'xmlns') {
            declare('', value);
            attributes.delete(attributeName);
          } else if (attributeName.startsWith('xmlns:')) {
            const [, prefix] = splitQName(attributeName);
            declare(prefix, value);
            attributes.delete(attributeName);
          }
        }
        const [prefix, local] = splitQName(qualifiedName);
        const name: ExpandedName = {
          localName: local,
          namespace: prefix === '' ? (bindings.get('')?.uri ?? null) : resolvePrefix(prefix).uri,
        };
        openNamespaces.push(name.namespace);
        openLocalNames.push(local);

        // Local names of the prefixed attributes, grouped by interned namespace: two prefixes bound to equal URIs share
        // an entry, so an attribute repeated under an alias is found without touching the URI.
        let localNamesByNamespace: Map<number, Set<string>> | undefined;
        for (const attributeName of attributes.keys()) {
          if (!attributeName.includes(':')) continue;
          const [attributePrefix, attributeLocal] = splitQName(attributeName);
          const { id } = resolvePrefix(attributePrefix);
          localNamesByNamespace ??= new Map();
          let localNames = localNamesByNamespace.get(id);
          if (localNames === undefined) {
            localNames = new Set();
            localNamesByNamespace.set(id, localNames);
          }
          if (localNames.has(attributeLocal)) malformed('an element repeats an attribute under two prefixes of one namespace');
          localNames.add(attributeLocal);
          attributes.delete(attributeName);
        }
        handlers.startElement(name, attributes);
      },
      text: (chunk) => handlers.text(chunk),
    },
    fail,
  );
}
