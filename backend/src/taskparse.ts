const ALIASES: Record<string, string> = {
  claim_status: "claim_status", "claim status": "claim_status",
  balance: "balance", payer: "payer", service_date: "service_date", "service date": "service_date",
};
/** Extracts the record id and requested fields from the operator's task text (coordinator-side contract). */
export function parseTask(task: string): { recordId?: string; fields: string[] } {
  const recordId = /SYN-\d{4}/i.exec(task)?.[0].toUpperCase();
  const lower = task.toLowerCase();
  return { recordId, fields: [...new Set(Object.keys(ALIASES).filter((k) => lower.includes(k)).map((k) => ALIASES[k]))] };
}
