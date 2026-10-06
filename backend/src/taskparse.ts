const ALIASES: Record<string, string> = {
  claim_status: "claim_status", "claim status": "claim_status",
  balance: "balance", payer: "payer", service_date: "service_date", "service date": "service_date",
};
/**
 * Extracts the record id and requested fields from the operator's task text.
 * Identifiers must be EXACT: every `SYN-` token in the text (with anything glued to either side) has to be a standalone
 * SYN-#### and there must be exactly one. Otherwise recordId is undefined and the task is rejected before any browser work.
 */
export function parseTask(task: string): { recordId?: string; fields: string[] } {
  const lower = task.toLowerCase();
  const fields = [...new Set(Object.keys(ALIASES).filter((k) => lower.includes(k)).map((k) => ALIASES[k]))];
  const loose = task.match(/[A-Za-z0-9_]*SYN-[A-Za-z0-9_]*/gi) ?? []; // any token containing SYN-, including glued prefixes/suffixes
  if (loose.length !== 1 || !/^SYN-\d{4}$/i.test(loose[0])) return { fields };
  return { recordId: loose[0].toUpperCase(), fields };
}
