import { z } from "zod";

export const FIELD_NAMES = ["claim_status", "balance", "payer", "service_date"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

const RecordId = z.string().regex(/^SYN-\d{4}$/, "record_id must look like SYN-1234");

/** The ONLY tools the model can request. No selectors, no JS, no click/type, no raw Playwright. */
export const ToolSchemas = {
  navigate: z.object({ url: z.string().max(2048) }).strict(),
  inspect: z.object({ region: z.enum(["record", "results"]) }).strict(),
  lookup_record: z.object({ record_id: RecordId }).strict(),
  open_record: z.object({ link_id: z.string().regex(/^r\d{1,2}$/) }).strict(),
  finish: z.object({
    status: z.enum(["found", "not_found", "uncertain"]),
    record_id: RecordId,
    fields: z.partialRecord(z.enum(FIELD_NAMES), z.string().max(200)).default({}),
  }).strict(),
} as const;
export type ToolName = keyof typeof ToolSchemas;
export const TOOL_NAMES = Object.keys(ToolSchemas) as ToolName[];

const DESCRIPTIONS: Record<ToolName, string> = {
  navigate: "Navigate the task tab to a URL on the approved synthetic records site (read-only routes only).",
  inspect: "Read bounded, filtered text of an approved page region. region=record for a record page, region=results for search results.",
  lookup_record: "Search the synthetic site for a record id (SYN-####). Returns result link ids.",
  open_record: "Open a record from the most recent lookup_record results using its link_id (e.g. r1).",
  finish: "End the task with a structured result. Use not_found if the record does not exist and uncertain if evidence is missing or conflicting. Only report field values you saw via inspect.",
};

export const TOOL_DEFS = TOOL_NAMES.map((name) => {
  const { $schema: _s, ...schema } = z.toJSONSchema(ToolSchemas[name]) as Record<string, unknown>;
  return { name, description: DESCRIPTIONS[name], input_schema: schema as { type: "object"; [k: string]: unknown } };
});

export type ValidatedCall = { ok: true; name: ToolName; input: any } | { ok: false; code: "UNKNOWN_TOOL" | "INVALID_ARGS" };
export function validateCall(name: string, input: unknown): ValidatedCall {
  if (!Object.hasOwn(ToolSchemas, name)) return { ok: false, code: "UNKNOWN_TOOL" };
  const r = ToolSchemas[name as ToolName].safeParse(input);
  return r.success ? { ok: true, name: name as ToolName, input: r.data } : { ok: false, code: "INVALID_ARGS" };
}
