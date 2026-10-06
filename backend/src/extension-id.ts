import { createHash } from "node:crypto";
/** Chrome derives the extension id from the manifest `key` (sha256 of the DER public key, first 16 bytes, hex mapped 0-f -> a-p). */
export function extensionIdFromManifest(m: { key: string }): string {
  const der = Buffer.from(m.key, "base64");
  return createHash("sha256").update(der).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)));
}
