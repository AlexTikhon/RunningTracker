import { describe, expect, it } from 'vitest';

import { scanNamespacedXml, scanXml, type ExpandedName, type XmlScanFailure } from './xml-scanner.js';

// The shared tokenizer (ADR-0086) and its namespace layer. Hostile-input timing lives in xml-scanner.hostile.spec.ts,
// which runs the parsers in a child process under an external deadline.

class ScanRefusal extends Error {
  public constructor(
    public readonly kind: XmlScanFailure,
    message: string,
  ) {
    super(message);
  }
}

const fail = (kind: XmlScanFailure, message: string): never => {
  throw new ScanRefusal(kind, message);
};

type Event = readonly ['start', string, Record<string, string>] | readonly ['end', string] | readonly ['text', string];

function events(text: string): Event[] {
  const seen: Event[] = [];
  scanXml(
    text,
    {
      endElement: (name) => seen.push(['end', name]),
      startElement: (name, attributes) => seen.push(['start', name, Object.fromEntries(attributes)]),
      text: (chunk) => {
        if (chunk.trim() !== '') seen.push(['text', chunk]);
      },
    },
    fail,
  );
  return seen;
}

function refusal(scan: () => unknown): ScanRefusal {
  try {
    scan();
  } catch (error) {
    expect(error).toBeInstanceOf(ScanRefusal);
    return error as ScanRefusal;
  }
  throw new Error('The document was accepted');
}

const expanded = (name: ExpandedName) => `${name.namespace === null ? '' : `{${name.namespace}}`}${name.localName}`;

type NamespacedEvent = readonly ['start', string, Record<string, string>] | readonly ['end', string];

function namespacedEvents(text: string): NamespacedEvent[] {
  const seen: NamespacedEvent[] = [];
  scanNamespacedXml(
    text,
    {
      endElement: (name) => seen.push(['end', expanded(name)]),
      startElement: (name, attributes) => seen.push(['start', expanded(name), Object.fromEntries(attributes)]),
      text: () => undefined,
    },
    fail,
  );
  return seen;
}

const starts = (text: string) => namespacedEvents(text).flatMap((event) => (event[0] === 'start' ? [event[1]] : []));

describe('XML tokenizer', () => {
  describe('attributes', () => {
    it('reads double- and single-quoted values exactly as written, with markup characters inside the quotes', () => {
      expect(events(`<a x="1 > 2" y='say "hi"' z = "a/b" e=""/>`)).toEqual([
        ['start', 'a', { e: '', x: '1 > 2', y: 'say "hi"', z: 'a/b' }],
        ['end', 'a'],
      ]);
    });

    it('accepts whitespace (space, tab, newline, carriage return) between attributes and before the tag end', () => {
      expect(events('<a\tx="1"\r\n y="2"  ></a>')).toEqual([['start', 'a', { x: '1', y: '2' }], ['end', 'a']]);
      expect(events('<a x="1" />')).toEqual([['start', 'a', { x: '1' }], ['end', 'a']]);
    });

    it.each([
      ['a name without a value', '<gpx x>'],
      ['a long name without a value', `<gpx ${'x'.repeat(1_000)}>`],
      ['a name with "=" but no value', '<gpx x=>'],
      ['an unquoted value', '<gpx x=1>'],
      ['an unterminated value', '<gpx x="1>'],
      ['no whitespace between attributes', '<gpx x="1"y="2"></gpx>'],
      ['a stray quote', '<gpx "x"></gpx>'],
      ['a slash that does not end the tag', '<gpx x="1" / ></gpx>'],
      ['a stray character after the name', '<gpx= x="1"></gpx>'],
      ['an unterminated tag', '<gpx x="1"'],
    ])('refuses %s as malformed', (_label, text) => {
      expect(refusal(() => events(text)).kind).toBe('malformed');
    });

    it('refuses a repeated attribute', () => {
      const error = refusal(() => events('<gpx x="1" x="2"></gpx>'));
      expect([error.kind, error.message]).toEqual(['malformed', 'The file is malformed XML: an element repeats an attribute']);
    });
  });

  describe('structure', () => {
    it('refuses mismatched, unclosed and doubled roots, and text outside the root', () => {
      for (const text of ['<a><b></a></b>', '<a><b></b>', '<a></a><a></a>', 'x<a></a>', '<a></a>x', '</a>', '<a></ a>', '<></>']) {
        expect(refusal(() => events(text)).kind, text).toBe('malformed');
      }
    });

    it('reports an empty or element-free document as not XML', () => {
      expect(refusal(() => events('')).kind).toBe('not_xml');
      expect(refusal(() => events('<?xml version="1.0"?><!-- nothing -->')).kind).toBe('not_xml');
    });

    it('passes comments over, CDATA through as text, and accepts whitespace before a closing ">"', () => {
      expect(events('<a><!-- <b> --><![CDATA[<c>]]></a >')).toEqual([['start', 'a', {}], ['text', '<c>'], ['end', 'a']]);
    });

    it.each([
      ['a DOCTYPE', '<!DOCTYPE gpx><gpx/>'],
      ['an internal entity', '<!DOCTYPE gpx [<!ENTITY e "x">]><gpx>&e;</gpx>'],
      ['a markup declaration inside an element', '<gpx><!ELEMENT gpx ANY></gpx>'],
      ['a conditional section', '<gpx><![INCLUDE[ x ]]></gpx>'],
    ])('refuses %s as a declaration', (_label, text) => {
      expect(refusal(() => events(text)).kind).toBe('declaration');
    });
  });
});

describe('XML namespaces', () => {
  const A = 'urn:a';
  const B = 'urn:b';

  it('resolves the default namespace and prefixes, with inherited bindings', () => {
    expect(starts(`<p:r xmlns:p="${A}" xmlns="${B}"><c><p:d/></c></p:r>`)).toEqual([`{${A}}r`, `{${B}}c`, `{${A}}d`]);
  });

  it('leaves unprefixed elements without a declared default namespace in no namespace', () => {
    expect(starts(`<p:r xmlns:p="${A}"><c/></p:r>`)).toEqual([`{${A}}r`, 'c']);
  });

  it('rebinds the default namespace and a prefix for a subtree, then restores the outer binding', () => {
    expect(
      starts(`<r xmlns="${A}" xmlns:p="${A}"><c xmlns="${B}" xmlns:p="${B}"><d/><p:e/></c><f/><p:g/></r>`),
    ).toEqual([`{${A}}r`, `{${B}}c`, `{${B}}d`, `{${B}}e`, `{${A}}f`, `{${A}}g`]);
  });

  it('restores bindings after a self-closing element that declared them', () => {
    expect(starts(`<r xmlns="${A}"><c xmlns="${B}"/><d/></r>`)).toEqual([`{${A}}r`, `{${B}}c`, `{${A}}d`]);
  });

  it('undeclares the default namespace with xmlns="" and restores it after the subtree', () => {
    expect(starts(`<r xmlns="${A}"><c xmlns=""><d/></c><e/></r>`)).toEqual([`{${A}}r`, 'c', 'd', `{${A}}e`]);
  });

  it('reports end elements with the binding that was in scope at their start', () => {
    expect(namespacedEvents(`<r xmlns="${A}"><c xmlns="${B}"></c></r>`).filter((event) => event[0] === 'end')).toEqual([
      ['end', `{${B}}c`],
      ['end', `{${A}}r`],
    ]);
  });

  it('passes attributes in no namespace by name, without namespace declarations or prefixed attributes', () => {
    expect(namespacedEvents(`<r xmlns="${A}" xmlns:p="${B}" lat="1" p:lat="2" xml:lang="en"/>`)[0]).toEqual([
      'start',
      `{${A}}r`,
      { lat: '1' },
    ]);
  });

  it('binds the xml prefix without a declaration', () => {
    expect(starts('<xml:r/>')).toEqual(['{http://www.w3.org/XML/1998/namespace}r']);
  });

  it.each([
    ['an undeclared element prefix', '<x:r/>'],
    ['an undeclared prefix on a child', `<r xmlns="${A}"><x:trk/></r>`],
    ['a prefix used outside the scope that declared it', `<r><c xmlns:x="${A}"/><x:d/></r>`],
    ['an undeclared attribute prefix', '<r x:lat="1"/>'],
    ['an empty prefix binding', '<x:r xmlns:x=""/>'],
    ['an element name with two colons', `<x:y:r xmlns:x="${A}"/>`],
    ['an element name starting with a colon', '<:r/>'],
    ['an element name ending with a colon', `<x: xmlns:x="${A}"/>`],
    ['an attribute name ending with a colon', '<r lat:="1"/>'],
    ['a declaration with no prefix after the colon', `<r xmlns:="${A}"/>`],
    ['the xmlns prefix on an element', '<xmlns:r/>'],
    ['a declaration of the xmlns prefix', `<r xmlns:xmlns="${A}"/>`],
    ['the xml prefix bound elsewhere', `<r xmlns:xml="${A}"/>`],
    ['another prefix bound to the XML namespace', '<r xmlns:x="http://www.w3.org/XML/1998/namespace"/>'],
    ['the default namespace bound to the XMLNS namespace', '<r xmlns="http://www.w3.org/2000/xmlns/"/>'],
    ['two attributes with the same expanded name', `<r xmlns:a="${A}" xmlns:b="${A}" a:x="1" b:x="2"/>`],
  ])('refuses %s', (_label, text) => {
    const error = refusal(() => namespacedEvents(text));
    expect(error.kind).toBe('malformed');
    expect(error.message).not.toContain('urn:');
  });

  it('accepts the xml prefix declared to its own namespace', () => {
    expect(starts('<r xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:lang="en"/>')).toEqual(['r']);
  });
});
