import { describe, it, expect } from 'vitest';
import {
  FRONT_DESK_TOOLS,
  TOOL_DESCRIPTIONS,
  TEXT_CHANNEL_TOOLS,
  toolJsonSchemas,
  IsoDate,
  type FrontDeskToolName,
} from '../src/front-desk-tools.ts';

const EXPECTED_NAMES: FrontDeskToolName[] = [
  'check_forecast',
  'book_inspection',
  'cancel_inspection',
  'confirm_appointment',
  'end_call',
  'find_inspection_times',
  'hail_at_my_home',
  'lookup_my_jobs',
  'move_inspection',
  'take_claim_details',
  'take_message',
  'transfer_to_person',
  'verify_caller',
];

const UUID = '123e4567-e89b-42d3-a456-426614174000';

type Node = Record<string, unknown>;

function walk(node: unknown, visit: (n: Node, path: string) => void, path = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, visit, `${path}[${i}]`));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const obj = node as Node;
  visit(obj, path);
  for (const [key, value] of Object.entries(obj)) {
    walk(value, visit, `${path}.${key}`);
  }
}

function schemaFor(name: string) {
  const tool = toolJsonSchemas().find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.input_schema as Node;
}

function propertySchema(tool: string, prop: string): Node {
  const props = schemaFor(tool).properties as Record<string, Node>;
  return props[prop] as Node;
}

describe('front desk tool registry', () => {
  it('has exactly the 13 tools', () => {
    expect(Object.keys(FRONT_DESK_TOOLS).sort()).toEqual([...EXPECTED_NAMES].sort());
    expect(Object.keys(FRONT_DESK_TOOLS)).toHaveLength(13);
  });

  it('exports an IsoDate that accepts YYYY-MM-DD only', () => {
    expect(IsoDate.safeParse('2026-10-12').success).toBe(true);
    expect(IsoDate.safeParse('2026-1-2').success).toBe(false);
  });
});

describe('toolJsonSchemas()', () => {
  it('lists tools in alphabetical order', () => {
    const names = toolJsonSchemas().map((t) => t.name);
    expect(names).toEqual([...EXPECTED_NAMES].sort());
  });

  it('is deterministic across calls', () => {
    expect(JSON.stringify(toolJsonSchemas())).toBe(JSON.stringify(toolJsonSchemas()));
  });

  it('gives each tool a non-empty description equal to TOOL_DESCRIPTIONS', () => {
    for (const tool of toolJsonSchemas()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.description).toBe(TOOL_DESCRIPTIONS[tool.name]);
    }
  });

  it('is strict at every object node', () => {
    for (const tool of toolJsonSchemas()) {
      walk(tool.input_schema, (node, path) => {
        if (node.type !== 'object') return;
        expect(node.additionalProperties, `${tool.name} ${path} additionalProperties`).toBe(false);
        const properties = (node.properties ?? {}) as Record<string, unknown>;
        const required = node.required as string[];
        expect(Array.isArray(required), `${tool.name} ${path} required is array`).toBe(true);
        expect(new Set(required), `${tool.name} ${path} required set`).toEqual(
          new Set(Object.keys(properties)),
        );
      });
    }
  });

  it('has no $schema or default keys anywhere', () => {
    for (const tool of toolJsonSchemas()) {
      walk(tool.input_schema, (node, path) => {
        expect(Object.prototype.hasOwnProperty.call(node, '$schema'), `${tool.name} ${path}`).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(node, 'default'), `${tool.name} ${path}`).toBe(false);
      });
    }
  });

  it('marks nullable fields as null-accepting and required', () => {
    const nullable: [string, string][] = [
      ['check_forecast', 'propertyId'],
      ['hail_at_my_home', 'propertyId'],
      ['find_inspection_times', 'propertyId'],
      ['find_inspection_times', 'address'],
      ['find_inspection_times', 'fromDate'],
      ['book_inspection', 'propertyId'],
      ['book_inspection', 'address'],
      ['take_claim_details', 'jobId'],
      ['take_claim_details', 'claimNumber'],
      ['take_claim_details', 'dateOfLoss'],
      ['take_claim_details', 'adjusterVisitAt'],
      ['take_message', 'callbackWhen'],
      ['take_message', 'name'],
    ];
    for (const [tool, prop] of nullable) {
      const schema = schemaFor(tool);
      expect((schema.required as string[]), `${tool}.${prop} required`).toContain(prop);
      expect(JSON.stringify(propertySchema(tool, prop)), `${tool}.${prop} allows null`).toContain('"null"');
    }
  });
});

describe('TEXT_CHANNEL_TOOLS', () => {
  it('has 11 entries and excludes voice-only tools', () => {
    expect(TEXT_CHANNEL_TOOLS).toHaveLength(11);
    expect(TEXT_CHANNEL_TOOLS).not.toContain('transfer_to_person');
    expect(TEXT_CHANNEL_TOOLS).not.toContain('end_call');
  });

  it('includes every other tool', () => {
    const expected = EXPECTED_NAMES.filter((n) => n !== 'transfer_to_person' && n !== 'end_call');
    expect([...TEXT_CHANNEL_TOOLS].sort()).toEqual(expected.sort());
  });
});

describe('zod input schemas', () => {
  const parse = (name: FrontDeskToolName, input: unknown) =>
    FRONT_DESK_TOOLS[name].input.safeParse(input).success;

  it('lookup_my_jobs accepts {} and rejects extra keys', () => {
    expect(parse('lookup_my_jobs', {})).toBe(true);
    expect(parse('lookup_my_jobs', { x: 1 })).toBe(false);
  });

  it('verify_caller rejects a one-letter name and accepts a valid pair', () => {
    expect(parse('verify_caller', { name: 'a', street: 'Oak' })).toBe(false);
    expect(parse('verify_caller', { name: 'Jo Smith', street: 'Oak' })).toBe(true);
  });

  it('check_forecast rejects bad dates and bad ids, accepts a null propertyId', () => {
    expect(parse('check_forecast', { date: '2026-1-2', propertyId: null })).toBe(false);
    expect(parse('check_forecast', { date: '2026-10-12', propertyId: null })).toBe(true);
    expect(parse('check_forecast', { date: '2026-10-12', propertyId: 'nope' })).toBe(false);
  });

  it('book_inspection rejects a missing notes key', () => {
    const input = {
      slotStart: '2026-10-13T15:00:00.000Z',
      slotUserId: UUID,
      propertyId: null,
      address: null,
      firstName: 'Jo',
      lastName: 'Smith',
    };
    expect(parse('book_inspection', input)).toBe(false);
    expect(parse('book_inspection', { ...input, notes: '' })).toBe(true);
  });

  it('end_call rejects reason other and accepts the three reasons', () => {
    expect(parse('end_call', { reason: 'other' })).toBe(false);
    for (const reason of ['goodbye', 'spam', 'silence']) {
      expect(parse('end_call', { reason })).toBe(true);
    }
  });

  it('transfer_to_person accepts each of the six reasons', () => {
    for (const reason of ['asked', 'leak', 'danger', 'angry', 'trade_caller', 'not_understood']) {
      expect(parse('transfer_to_person', { reason, summary: 'Wants a person' })).toBe(true);
    }
    expect(parse('transfer_to_person', { reason: 'bored', summary: 'x' })).toBe(false);
  });

  it('every tool rejects unknown extra keys', () => {
    for (const name of EXPECTED_NAMES) {
      expect(parse(name, { __unknown__: 'x' }), name).toBe(false);
    }
  });
});

describe('strict-mode schema keywords', () => {
  it('emitted tool schemas contain no unsupported strict-mode keywords', () => {
    const banned = ['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'pattern'];
    for (const tool of toolJsonSchemas()) {
      walk(tool.input_schema, (node, path) => {
        // A property named like a keyword lives inside a 'properties' map; skip those maps.
        if (path.endsWith('.properties')) return;
        for (const key of banned) {
          expect(Object.prototype.hasOwnProperty.call(node, key), `${tool.name} ${path} ${key}`).toBe(false);
        }
        if (node.type === 'object') {
          expect(node.additionalProperties, `${tool.name} ${path}`).toBe(false);
        }
      });
    }
    expect(propertySchema('check_forecast', 'date')).toEqual({ type: 'string', format: 'date' });
  });
});
