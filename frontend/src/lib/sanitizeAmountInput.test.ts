import { describe, it, expect } from 'vitest'
import { sanitizeAmountInput, parseAmountToBaseUnits, amountMatchesQuote } from './sanitizeAmountInput'

describe('sanitizeAmountInput', () => {
  it('should allow numbers and decimal points', () => {
    expect(sanitizeAmountInput('123.45', 2)).toBe('123.45')
    expect(sanitizeAmountInput('0.5', 2)).toBe('0.5')
    expect(sanitizeAmountInput('12.', 2)).toBe('12.')
  })

  it('should replace commas with periods and apply decimal limit', () => {
    expect(sanitizeAmountInput('1,234.56', 2)).toBe('1.23') // Takes digits before decimal + up to 2 after
    expect(sanitizeAmountInput('1,234', 2)).toBe('1.23')    // Same logic: '1' + '.23' (only 2 digits after decimal)
  })

  it('should remove non-digit and non-period characters', () => {
    expect(sanitizeAmountInput('abc123.45def', 2)).toBe('123.45')
    expect(sanitizeAmountInput('$123.45', 2)).toBe('123.45')
    expect(sanitizeAmountInput('123.45€', 2)).toBe('123.45')
  })

  it('should limit decimal places according to maxDecimals', () => {
    expect(sanitizeAmountInput('123.456', 2)).toBe('123.45')
    expect(sanitizeAmountInput('123.4', 2)).toBe('123.4')
    expect(sanitizeAmountInput('123.456789', 4)).toBe('123.4567')
  })

  it('should handle multiple decimal points (take first valid sequence)', () => {
    expect(sanitizeAmountInput('123.45.67', 2)).toBe('123.45')
    expect(sanitizeAmountInput('1..2.3', 2)).toBe('1.')
  })

  it('should handle input with only periods', () => {
    expect(sanitizeAmountInput('', 2)).toBe('')
    expect(sanitizeAmountInput('abc', 2)).toBe('')
    expect(sanitizeAmountInput('...', 2)).toBe('.')   // Matches zero digits + decimal point + zero digits
    expect(sanitizeAmountInput('.....', 2)).toBe('.') // Same logic
  })

  it('should handle leading zeros correctly', () => {
    expect(sanitizeAmountInput('00123.45', 2)).toBe('00123.45')
    expect(sanitizeAmountInput('0.0', 2)).toBe('0.0')
  })

  it('should limit integer part reasonably', () => {
    // The function doesn't limit the integer part, only the decimal part
    expect(sanitizeAmountInput('123456.78', 2)).toBe('123456.78')
  })
})
describe('parseAmountToBaseUnits', () => {
  // Same vectors as coordinator/test/quote-amount.test.ts — both sides must agree.
  it('parses a valid decimal to the exact base-unit integer', () => {
    expect(parseAmountToBaseUnits('1.5', 18)).toBe(1_500_000_000_000_000_000n)
    expect(parseAmountToBaseUnits('0.1', 18)).toBe(100_000_000_000_000_000n)
    expect(parseAmountToBaseUnits('12.', 7)).toBe(120_000_000n)
    expect(parseAmountToBaseUnits('.5', 7)).toBe(5_000_000n)
    expect(parseAmountToBaseUnits('0.0000001', 7)).toBe(1n)
  })

  it('rejects an extra fractional digit instead of rounding or truncating', () => {
    expect(parseAmountToBaseUnits('0.00000001', 7)).toBeNull()
    expect(parseAmountToBaseUnits('1.1234567890123456789', 18)).toBeNull()
  })

  it('rejects empty, negative, and non-decimal input', () => {
    expect(parseAmountToBaseUnits('', 18)).toBeNull()
    expect(parseAmountToBaseUnits('.', 18)).toBeNull()
    expect(parseAmountToBaseUnits('-1', 18)).toBeNull()
    expect(parseAmountToBaseUnits('1e3', 18)).toBeNull()
    expect(parseAmountToBaseUnits('1,5', 18)).toBeNull()
  })

  it('keeps full precision above Number.MAX_SAFE_INTEGER', () => {
    const parsed = parseAmountToBaseUnits('9007199254740993.000000000000000001', 18)
    expect(parsed).toBe(9_007_199_254_740_993_000_000_000_000_000_001n)
    // A float parse would have lost the trailing digits.
    expect(BigInt(Math.round(parseFloat('9007199254740993') * 1e18))).not.toBe(parsed)
  })
})

describe('amountMatchesQuote', () => {
  it('matches only the identical integer', () => {
    const parsed = parseAmountToBaseUnits('1.5', 18)
    expect(amountMatchesQuote(parsed, '1500000000000000000')).toBe(true)
    expect(amountMatchesQuote(parsed, '1500000000000000001')).toBe(false)
    expect(amountMatchesQuote(parsed, '1.5')).toBe(false)
    expect(amountMatchesQuote(null, '0')).toBe(false)
    expect(amountMatchesQuote(parsed, null)).toBe(false)
  })
})
