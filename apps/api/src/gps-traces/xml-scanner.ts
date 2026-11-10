// A strict, minimal XML tokenizer shared by the GPX readers (the D10 trace tools and the activity import, ADR-0086).
// It is intentionally not a general XML parser:
//  - a DOCTYPE, an entity declaration and every other markup declaration (`<!` that is not a comment or CDATA) is
//    refused, so there is nothing to expand and no external resource to fetch: nothing here ever opens a URL or a file;
//  - entity and character references are never expanded: text and attribute values are passed on exactly as written,
//    so a reader that needs a number or an instant simply fails to parse a value that contains one;
//  - tags must nest and close; text outside the root element is refused.
// Callers decide which elements mean anything; everything else is skipped and never stored.

export type XmlScanFailure = 'declaration' | 'malformed' | 'not_xml';

export interface XmlScanHandlers {
  /** Attribute names are qualified, exactly as written (`xmlns:gpx`, `lat`). */
  startElement(qualifiedName: string, attributes: ReadonlyMap<string, string>): void;
  endElement(qualifiedName: string): void;
  /** Character data between tags and the content of CDATA sections, in document order. */
  text(chunk: string): void;
}

/** Called with a complete, human-readable message that never quotes the document. Must throw. */
export type XmlScanFail = (kind: XmlScanFailure, message: string) => never;

const ATTRIBUTE = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
const DECLARATION = /<!DOCTYPE|<!ENTITY|<!\[(?!CDATA\[)/iu;

export const DECLARATION_MESSAGE =
  'The file declares a DOCTYPE or entities; DTDs are not supported, export a plain GPX file';

export function localName(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);
}

export function scanXml(text: string, handlers: XmlScanHandlers, fail: XmlScanFail): void {
  const malformed = (detail: string): never => fail('malformed', `The file is malformed XML: ${detail}`);
  if (DECLARATION.test(text)) {
    fail('declaration', DECLARATION_MESSAGE);
  }

  const parseAttributes = (source: string): Map<string, string> => {
    const attributes = new Map<string, string>();
    for (const match of source.matchAll(ATTRIBUTE)) {
      const name = match[1] as string;
      if (attributes.has(name)) {
        malformed('an element repeats an attribute');
      }
      attributes.set(name, (match[2] ?? match[3]) as string);
    }
    if (source.replace(ATTRIBUTE, '').trim() !== '') {
      malformed('an element has an attribute that is not name="value"');
    }
    return attributes;
  };

  const stack: string[] = [];
  let sawElement = false;
  let position = 0;
  while (position < text.length) {
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
    } else {
      // The end of a tag is the first '>' outside a quoted attribute value.
      let quote = '';
      let end = -1;
      for (let index = open + 1; index < text.length; index += 1) {
        const character = text[index] as string;
        if (quote !== '') {
          if (character === quote) {
            quote = '';
          }
        } else if (character === '"' || character === "'") {
          quote = character;
        } else if (character === '>') {
          end = index;
          break;
        }
      }
      if (end === -1) {
        malformed('an unterminated tag');
      }
      const tag = text.slice(open + 1, end);
      if (tag.startsWith('/')) {
        const qualifiedName = tag.slice(1).trim();
        if (stack.pop() !== qualifiedName) {
          malformed('a closing tag does not match its opening tag');
        }
        handlers.endElement(qualifiedName);
      } else {
        const selfClosing = tag.endsWith('/');
        const body = selfClosing ? tag.slice(0, -1) : tag;
        const nameMatch = /^([^\s/>]+)([\s\S]*)$/u.exec(body);
        if (!nameMatch) {
          return malformed('an element has no name');
        }
        if (stack.length === 0 && sawElement) {
          malformed('more than one root element');
        }
        sawElement = true;
        const qualifiedName = nameMatch[1] as string;
        stack.push(qualifiedName);
        handlers.startElement(qualifiedName, parseAttributes(nameMatch[2] as string));
        if (selfClosing) {
          stack.pop();
          handlers.endElement(qualifiedName);
        }
      }
      position = end + 1;
    }
  }

  if (!sawElement) {
    fail('not_xml', 'The file is not XML (expected a GPX document); it may be empty or in another format');
  }
  if (stack.length !== 0) {
    malformed('an element is never closed');
  }
}
