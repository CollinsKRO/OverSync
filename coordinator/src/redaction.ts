/** Redact secrets in serialized coordinator output before it is written. */
export function redactSensitive(value: string): string {
  return value
    // Remove URL userinfo while retaining the RPC host for diagnosis.
    .replace(/\b(https?:\/\/)[^\s/"\\]+@/gi, "$1")
    // Pino JSON fields and Prometheus label values can both carry secrets.
    .replace(/("(?:preimage|authorization)"\s*:\s*")((?:\\.|[^"\\])*)"/gi, '$1[REDACTED]"')
    .replace(/\b(preimage|authorization)(\s*=\s*")((?:\\.|[^"\\])*)"/gi, '$1$2[REDACTED]"')
    // Also cover error messages and header strings that are not structured fields.
    .replace(/\b(preimage|authorization)(\s*[:=]\s*)(?:Bearer|Basic)?\s*[^\s,;"\\}]+/gi, "$1$2[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;"\\}]+/gi, "$1 [REDACTED]")
    .replace(/\b0x[0-9a-f]{64}\b/gi, "[REDACTED]")
    // Catch long descriptive tokens that identify themselves as preimages.
    .replace(/\b[A-Za-z0-9_-]*preimage[A-Za-z0-9_-]*\b/gi, (token) =>
      token.length >= 24 ? "[REDACTED]" : token
    );
}
