/**
 * Nominal ("branded") types.
 *
 * A plain `number` is a terrible type for a quality setting: v1 shipped a bug
 * where a 1-100 quality value was passed straight into ffmpeg's `-crf` flag,
 * which accepts 0-51. Both are `number`, so the compiler had nothing to say.
 *
 * Branding makes those two scales distinct types, so a `Quality` can never be
 * silently used where a `Crf` is expected. The brand exists only at compile
 * time — at runtime these are ordinary numbers with zero overhead.
 */

declare const BRAND: unique symbol;

export type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/** Perceptual quality on a friendly 1-100 scale. Higher means better looking. */
export type Quality = Brand<number, "Quality">;

/**
 * A codec's Constant Rate Factor. Lower means better looking — the inverse of
 * {@link Quality} — and the valid range differs per codec, which is why this
 * may only be produced by {@link qualityToCrf}.
 */
export type Crf = Brand<number, "Crf">;

/** A pixel dimension: a positive, finite integer. */
export type Pixels = Brand<number, "Pixels">;

export class RangeValidationError extends Error {
  constructor(
    readonly field: string,
    readonly value: unknown,
    readonly expectation: string,
  ) {
    super(`Invalid ${field}: got ${String(value)}, expected ${expectation}.`);
    this.name = "RangeValidationError";
  }
}

export const QUALITY_MIN = 1;
export const QUALITY_MAX = 100;

/**
 * The only way to obtain a {@link Quality}. Rejects anything outside 1-100 so
 * that every downstream consumer can assume the invariant holds.
 */
export function toQuality(value: number): Quality {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeValidationError("quality", value, "a whole number");
  }
  if (value < QUALITY_MIN || value > QUALITY_MAX) {
    throw new RangeValidationError(
      "quality",
      value,
      `a value between ${QUALITY_MIN} and ${QUALITY_MAX}`,
    );
  }
  return value as Quality;
}

/** The only way to obtain a {@link Pixels}. */
export function toPixels(value: number, field = "dimension"): Pixels {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new RangeValidationError(field, value, "a positive whole number");
  }
  return value as Pixels;
}

/** Unsafely tag a number that has already been range-checked by its producer. */
export function unsafeCrf(value: number): Crf {
  return value as Crf;
}
