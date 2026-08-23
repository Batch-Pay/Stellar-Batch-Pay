import Big from 'big.js'
import { Asset as StellarAsset } from 'stellar-sdk'

/**
 * Truncates a string to at most `maxBytes` UTF-8 bytes without splitting
 * multi-byte characters (emoji, CJK, accented chars, etc.).
 *
 * Stellar MEMO_TEXT must be ≤ 28 bytes UTF-8.  JavaScript's String.slice
 * operates on code units, not bytes, so a naive `.slice(0, 28)` can still
 * exceed 28 bytes for non-ASCII input.
 *
 * @param value    The string to truncate
 * @param maxBytes Maximum byte length (default 28 for Stellar MEMO_TEXT)
 * @returns A string whose UTF-8 encoding is ≤ maxBytes bytes
 */
export function truncateMemoToBytes(value: string, maxBytes = 28): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.length <= maxBytes) return value;
  // Decode only the first maxBytes bytes; TextDecoder ignores incomplete
  // multi-byte sequences at the boundary via the default replacement behaviour,
  // but we want clean truncation so we trim trailing incomplete sequences.
  const slice = encoded.slice(0, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(slice).replace(/�+$/, '');
}

/**
 * Formats a Stellar amount string or number to show up to 7 decimal places
 * and trims any trailing zeros.
 * 
 * @param amount The amount to format
 * @returns A formatted string with up to 7 decimal places and no trailing zeros
 */
export function formatAmount(amount: string | number): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  
  if (isNaN(num)) return '0';
  
  // Stellar supports up to 7 decimal places.
  // Using toFixed(7) ensures we don't exceed that precision and avoid scientific notation for small numbers.
  // The regex removes trailing zeros and the decimal point if it becomes unnecessary.
  return num.toFixed(7).replace(/\.?0+$/, '');
}

// Stellar uses 7 decimal places (1 XLM = 10,000,000 stroops)
const STELLAR_DECIMALS = 7
const STELLAR_STROOPS_PER_UNIT = new Big(10 ** STELLAR_DECIMALS)
const STELLAR_MAX_AMOUNT = new Big('922337203685.4775807')

/**
 * Parses a Stellar amount string into a Big instance for safe arithmetic.
 *
 * Stellar amounts are always strings with up to 7 decimal places.
 * This function rejects invalid inputs early to prevent silent errors
 * from propagating through batch calculations.
 *
 * @param s - The amount string to parse (e.g. "100.1234567")
 * @returns A Big instance representing the amount
 * @throws {Error} If the input is not a valid finite Stellar amount string
 *
 * @example
 * parseStellarAmount("100.5")        // → Big(100.5)
 * parseStellarAmount("0.0000001")    // → Big(0.0000001)  (1 stroop)
 * parseStellarAmount("abc")          // → throws
 * parseStellarAmount("")             // → throws
 * parseStellarAmount("-1")           // → throws
 * parseStellarAmount("1e7")          // → throws (no scientific notation)
 */
export function parseStellarAmount(s: string): Big {
  // Reject non-string, empty, or whitespace-only input
  if (typeof s !== 'string' || s.trim() === '') {
    throw new Error(`Invalid Stellar amount: expected non-empty string, got ${JSON.stringify(s)}`)
  }

  // Reject scientific notation (Stellar SDK never uses it, but guard anyway)
  if (s.includes('e') || s.includes('E')) {
    throw new Error(`Invalid Stellar amount: scientific notation not allowed: "${s}"`)
  }

  let amount: Big
  try {
    amount = new Big(s)
  } catch {
    throw new Error(`Invalid Stellar amount: "${s}" is not a valid number`)
  }

  // Reject negative amounts
  if (amount.lt(0)) {
    throw new Error(`Invalid Stellar amount: negative amounts not allowed: "${s}"`)
  }

  // Reject values exceeding Stellar's int64 max
  if (amount.gt(STELLAR_MAX_AMOUNT)) {
    throw new Error(
      `Invalid Stellar amount: "${s}" exceeds maximum Stellar amount (${STELLAR_MAX_AMOUNT.toFixed(STELLAR_DECIMALS)})`
    )
  }

  // Reject more than 7 decimal places
  const decimalPart = s.split('.')[1]
  if (decimalPart && decimalPart.length > STELLAR_DECIMALS) {
    throw new Error(
      `Invalid Stellar amount: "${s}" has more than ${STELLAR_DECIMALS} decimal places`
    )
  }

  return amount
}

/**
 * Converts a human-readable Stellar amount string into i128 stroops (bigint).
 *
 * Stellar amounts have exactly 7 decimal places of precision; 1 unit = 10,000,000
 * stroops. This uses big.js decimal arithmetic instead of `parseFloat`, so values
 * like "123456789.1234567" or "0.0000001" convert to the exact stroop integer with
 * no binary floating-point rounding error. Invalid, negative, out-of-range, or
 * over-precise inputs are rejected by {@link parseStellarAmount} before conversion,
 * so a malformed amount never reaches Soroban as a wrong i128 value.
 *
 * This is the single source of truth for stroop conversion shared by the vesting
 * deposit/claim code and any other Soroban i128 amount serialization (#506).
 *
 * @param amount - The amount string to convert (e.g. "100.1234567")
 * @returns The amount in stroops as a bigint (e.g. 1001234567n)
 * @throws {Error} If the input is not a valid Stellar amount string
 *
 * @example
 * amountToStroopsI128("0.0000001")     // → 1n
 * amountToStroopsI128("100")           // → 1000000000n
 * amountToStroopsI128("99999999.9999999") // → 999999999999999n
 * amountToStroopsI128("0.12345678")    // → throws (8 decimal places)
 */
export function amountToStroopsI128(amount: string): bigint {
  const value = parseStellarAmount(amount)
  // parseStellarAmount guarantees ≤ 7 decimal places, so multiplying by 1e7
  // yields an exact integer; round(0) is defensive and never discards data here.
  const stroops = value.times(STELLAR_STROOPS_PER_UNIT).round(0)
  return BigInt(stroops.toFixed(0))
}

/**
 * Thrown when an amount string has more fractional digits than the target
 * token supports. Callers can catch this specifically to surface a
 * precision-specific message instead of a generic parse failure (#712).
 */
export class ExcessTokenPrecisionError extends Error {
  constructor(
    public readonly amount: string,
    public readonly tokenDecimals: number,
  ) {
    super(
      `Invalid amount: "${amount}" has more than ${tokenDecimals} decimal places`
    )
    this.name = 'ExcessTokenPrecisionError'
  }
}

/**
 * Parses an amount string into a Big instance for a token with an arbitrary
 * number of decimal places (6, 7, 18, ...).
 *
 * Generalizes {@link parseStellarAmount} for Soroban token contracts whose
 * `decimals()` differs from the classic 7-decimal Stellar scale (#712).
 * Unlike {@link parseStellarAmount}, this does not enforce the classic
 * Horizon int64 amount ceiling, since Soroban token amounts are i128 and are
 * not bound by that limit.
 *
 * @param s - The amount string to parse (e.g. "100.123456")
 * @param decimals - The token's decimal precision
 * @throws {ExcessTokenPrecisionError} if `s` has more fractional digits than `decimals`
 * @throws {Error} if `s` is not a valid non-negative finite decimal string
 */
export function parseTokenAmount(s: string, decimals: number): Big {
  if (typeof s !== 'string' || s.trim() === '') {
    throw new Error(`Invalid amount: expected non-empty string, got ${JSON.stringify(s)}`)
  }

  // Reject scientific notation for the same reason as parseStellarAmount.
  if (s.includes('e') || s.includes('E')) {
    throw new Error(`Invalid amount: scientific notation not allowed: "${s}"`)
  }

  let amount: Big
  try {
    amount = new Big(s)
  } catch {
    throw new Error(`Invalid amount: "${s}" is not a valid number`)
  }

  if (amount.lt(0)) {
    throw new Error(`Invalid amount: negative amounts not allowed: "${s}"`)
  }

  const decimalPart = s.split('.')[1]
  if (decimalPart && decimalPart.length > decimals) {
    throw new ExcessTokenPrecisionError(s, decimals)
  }

  return amount
}

/**
 * Converts a human-readable token amount string into an i128 bigint, scaled
 * by the token's own `decimals` rather than the fixed 7-decimal Stellar
 * scale (#712). Uses big.js decimal arithmetic — never floating point — so
 * the conversion is exact for any decimal count.
 *
 * @example
 * amountToTokenStroopsI128("1", 6)   // → 1000000n
 * amountToTokenStroopsI128("1", 7)   // → 10000000n
 * amountToTokenStroopsI128("1", 18)  // → 1000000000000000000n
 */
export function amountToTokenStroopsI128(amount: string, decimals: number): bigint {
  const value = parseTokenAmount(amount, decimals)
  const scale = new Big(10).pow(decimals)
  // decimals is guaranteed by parseTokenAmount, so this multiplication is exact.
  const stroops = value.times(scale).round(0)
  return BigInt(stroops.toFixed(0))
}

/**
 * Formats a Big instance back to a Stellar-compatible amount string.
 * Always produces exactly 7 decimal places.
 *
 * @param amount - The Big instance to format
 * @returns A string with exactly 7 decimal places (e.g. "100.1234567")
 *
 * @example
 * formatStellarAmount(new Big("100.5"))   // → "100.5000000"
 * formatStellarAmount(new Big("0"))       // → "0.0000000"
 */
export function formatStellarAmount(amount: Big): string {
  return amount.toFixed(STELLAR_DECIMALS)
}

/**
 * Sums an array of Stellar amount strings using Big arithmetic.
 * Safe for large batches — no float accumulation errors.
 *
 * @param amounts - Array of amount strings to sum
 * @returns Big instance representing the total
 * @throws {Error} If any amount string is invalid
 *
 * @example
 * sumStellarAmounts(["0.1", "0.2"])  // → Big(0.3) exactly
 */
export function sumStellarAmounts(amounts: string[]): Big {
  return amounts.reduce(
    (acc, amount) => acc.plus(parseStellarAmount(amount)),
    new Big(0)
  )
}

/**
 * Parses an asset string into a stellar-sdk Asset instance.
 * Accepts "XLM" / "native" for the native asset, or "CODE:ISSUER" for issued assets.
 *
 * @param asset - Asset string or object with { code, issuer }
 * @returns A stellar-sdk Asset instance
 * @throws {Error} If the input cannot be resolved to a valid asset
 *
 * @example
 * parseAsset("XLM")                          // → Asset.native()
 * parseAsset("USDC:GBUQWP3B...")             // → new Asset("USDC", "GBUQWP3B...")
 * parseAsset({ code: "USDC", issuer: "G…" }) // → new Asset("USDC", "G…")
 */
export function parseAsset(asset: string | { code: string; issuer: string | null }): StellarAsset {
  if (typeof asset === 'string') {
    if (asset === 'XLM' || asset === 'native') {
      return StellarAsset.native()
    }
    const colonIndex = asset.indexOf(':')
    if (colonIndex === -1) {
      throw new Error(`Invalid asset string "${asset}": expected "CODE:ISSUER" or "XLM"`)
    }
    const code = asset.slice(0, colonIndex)
    const issuer = asset.slice(colonIndex + 1)
    if (!code || !issuer) {
      throw new Error(`Invalid asset string "${asset}": code and issuer must be non-empty`)
    }
    return new StellarAsset(code, issuer)
  }

  if (!asset.code || asset.issuer === undefined) {
    throw new Error('Invalid asset object: must provide code and issuer')
  }
  if (asset.issuer === null || asset.code === 'XLM') {
    return StellarAsset.native()
  }
  return new StellarAsset(asset.code, asset.issuer)
}
