/** Allow only non-negative decimal amounts (e.g. "0.5", "12." while typing). */
export function sanitizeAmountInput(raw: string, maxDecimals: number): string {
  const cleaned = raw.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const match = cleaned.match(new RegExp(`^\\d*(?:\\.\\d{0,${maxDecimals}})?`));
  return match?.[0] ?? '';
}

const DECIMAL_AMOUNT = /^(\d+)(?:\.(\d*))?$|^\.(\d+)$/;

/**
 * Parse a decimal amount into token base units using only string/BigInt
 * arithmetic (no floating point, so values above Number.MAX_SAFE_INTEGER
 * keep full precision).
 *
 * Returns `null` for empty input, signs, exponents, non-digits, or more
 * fractional digits than `decimals` allows — it never rounds or truncates.
 * Mirrors `parseAmountToBaseUnits` in
 * `coordinator/src/services/quote-service.ts`; both must return the same
 * integer for the same text.
 */
export function parseAmountToBaseUnits(raw: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  const match = DECIMAL_AMOUNT.exec(raw.trim());
  if (!match) return null;
  const whole = match[1] ?? '0';
  const frac = match[2] ?? match[3] ?? '';
  if (frac.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/**
 * True only when the form's parsed amount and the quote's base-unit amount
 * are the same integer. A missing or malformed quote amount never matches.
 */
export function amountMatchesQuote(formBaseUnits: bigint | null, quoteBaseUnits: string | null | undefined): boolean {
  if (formBaseUnits === null || quoteBaseUnits == null) return false;
  if (!/^(0|[1-9]\d*)$/.test(quoteBaseUnits)) return false;
  return formBaseUnits === BigInt(quoteBaseUnits);
}
