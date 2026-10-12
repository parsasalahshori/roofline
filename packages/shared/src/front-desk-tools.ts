import { z } from 'zod';

// Calendar date as YYYY-MM-DD. Shared by the Front Desk tool schemas.
export const IsoDate = z.string().date();

// Tool input schemas. Every object is strict; nullable fields are nullable, never optional.
export const FRONT_DESK_TOOLS = {
  lookup_my_jobs: { input: z.object({}).strict() },
  verify_caller: {
    input: z
      .object({
        name: z.string().min(2).max(80),
        street: z.string().min(2).max(80),
      })
      .strict(),
  },
  check_forecast: {
    input: z
      .object({
        date: IsoDate,
        propertyId: z.string().uuid().nullable(),
      })
      .strict(),
  },
  hail_at_my_home: {
    input: z
      .object({
        propertyId: z.string().uuid().nullable(),
      })
      .strict(),
  },
  find_inspection_times: {
    input: z
      .object({
        propertyId: z.string().uuid().nullable(),
        address: z.string().max(200).nullable(),
        fromDate: IsoDate.nullable(),
        partOfDay: z.enum(['any', 'morning', 'afternoon']),
      })
      .strict(),
  },
  book_inspection: {
    input: z
      .object({
        slotStart: z.string().datetime(),
        slotUserId: z.string().uuid(),
        propertyId: z.string().uuid().nullable(),
        address: z.string().max(200).nullable(),
        firstName: z.string().max(60),
        lastName: z.string().max(60),
        notes: z.string().max(500),
      })
      .strict(),
  },
  confirm_appointment: {
    input: z
      .object({
        appointmentId: z.string().uuid(),
      })
      .strict(),
  },
  move_inspection: {
    input: z
      .object({
        appointmentId: z.string().uuid(),
        slotStart: z.string().datetime(),
        slotUserId: z.string().uuid(),
      })
      .strict(),
  },
  cancel_inspection: {
    input: z
      .object({
        appointmentId: z.string().uuid(),
        reason: z.string().max(200),
      })
      .strict(),
  },
  take_claim_details: {
    input: z
      .object({
        jobId: z.string().uuid().nullable(),
        insurer: z.string().max(80),
        claimNumber: z.string().max(40).nullable(),
        dateOfLoss: IsoDate.nullable(),
        description: z.string().max(1000),
        adjusterVisitAt: z.string().datetime().nullable(),
      })
      .strict(),
  },
  take_message: {
    input: z
      .object({
        reason: z.string().max(500),
        urgent: z.boolean(),
        callbackWhen: z.string().max(100).nullable(),
        name: z.string().max(80).nullable(),
      })
      .strict(),
  },
  transfer_to_person: {
    input: z
      .object({
        reason: z.enum(['asked', 'leak', 'danger', 'angry', 'trade_caller', 'not_understood']),
        summary: z.string().max(200),
      })
      .strict(),
  },
  end_call: {
    input: z
      .object({
        reason: z.enum(['goodbye', 'spam', 'silence']),
      })
      .strict(),
  },
} as const;

export type FrontDeskToolName = keyof typeof FRONT_DESK_TOOLS;

// Stable plain-English descriptions. Part of the cached prompt prefix: do not make them dynamic.
export const TOOL_DESCRIPTIONS: Record<FrontDeskToolName, string> = {
  lookup_my_jobs: "Look up the verified caller's existing jobs with this company.",
  verify_caller: "Check the caller's name and street address against the company's customer records.",
  check_forecast: "Look up the hail and weather forecast for a given date at the caller's property.",
  hail_at_my_home: "Look up recent hail history recorded for the caller's property.",
  find_inspection_times: 'Find open inspection time slots for a property or address, filtered by part of day.',
  book_inspection: "Book an inspection at a chosen open time slot for the caller.",
  confirm_appointment: "Confirm an existing inspection appointment for the caller.",
  move_inspection: 'Move an existing inspection appointment to a different open time slot.',
  cancel_inspection: "Cancel an existing inspection appointment, recording the caller's reason.",
  take_claim_details: "Record the details of the caller's insurance claim for the team to follow up on.",
  take_message: 'Record a message from the caller for the team, noting whether it is urgent and when to call back.',
  transfer_to_person: 'Transfer the call to a person at the company, with a short summary of why.',
  end_call: 'End the call politely with a stated reason.',
};

// Tools available on the text channel: everything except the voice-only transfer and call end.
export const TEXT_CHANNEL_TOOLS: readonly FrontDeskToolName[] = (
  Object.keys(FRONT_DESK_TOOLS) as FrontDeskToolName[]
).filter((name) => name !== 'transfer_to_person' && name !== 'end_call');

type JsonNode = Record<string, unknown>;

function isJsonNode(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Keywords strict tool use rejects (Ruling DM). The engine's zod .parse still enforces every limit.
const UNSUPPORTED_KEYWORDS = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'pattern']);

// Makes every object strict: additionalProperties false, and every property required.
// Recurses through all nested schema nodes; drops $schema and any default.
function strictify(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => strictify(item));
  }
  if (!isJsonNode(node)) {
    return node;
  }
  const out: JsonNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === 'default' || UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key] =
      key === 'properties' && isJsonNode(value)
        ? Object.fromEntries(Object.entries(value).map(([prop, schema]) => [prop, strictify(schema)]))
        : strictify(value);
  }
  if (out.type === 'object' || isJsonNode(out.properties)) {
    const properties = isJsonNode(out.properties) ? out.properties : {};
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

// Alphabetical by name, so the tool list bytes are identical on every call (prompt cache stability).
export function toolJsonSchemas(): { name: FrontDeskToolName; description: string; input_schema: object }[] {
  const names = (Object.keys(FRONT_DESK_TOOLS) as FrontDeskToolName[]).slice().sort();
  return names.map((name) => {
    const converted = z.toJSONSchema(FRONT_DESK_TOOLS[name].input, { target: 'draft-7' });
    const input_schema = strictify(converted);
    if (!isJsonNode(input_schema)) {
      throw new Error(`front-desk tool ${name} did not convert to an object schema`);
    }
    return { name, description: TOOL_DESCRIPTIONS[name], input_schema };
  });
}
