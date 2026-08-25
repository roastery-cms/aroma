import { type RedactionPlaceholder, redactionConfig } from "@roastery/beans";
import type { IValueObjectContext } from "@roastery/beans/domain/value-object/types";

/**
 * `source` reported to a placeholder function when the redacted value has no
 * domain object of its own to name — i.e. when the logger masks a key by
 * name rather than a `ValueObject` that knows which aggregate it belongs to.
 *
 * @internal
 */
export const AROMA_SOURCE = "@roastery/aroma";

/**
 * Resolve what a redacted value is replaced with, honouring the
 * package-wide redaction settings of `@roastery/beans`.
 *
 * @remarks
 * The placeholder is read **per call**, never cached: `configureRedaction`
 * is a runtime switch, and a logger built before it runs must still observe
 * the new setting. Reading `redactionConfig()` is a plain object read.
 *
 * A placeholder may be a ready value or a function computing one from the
 * real value plus its `{ name, source }` — which is how `beans` expresses
 * partial masking (`a***@b.dev`, last four digits). The two are told apart
 * by `typeof === "function"`, the same discriminant `beans` itself uses.
 *
 * @param value - the real value about to be replaced; only ever handed to a
 *   placeholder **function**, never emitted directly.
 * @param context - `{ name, source }` identifying whose value this is.
 * @param override - a per-class `redactWith` placeholder that wins over the
 *   configured one. `undefined` means "no override" — and `undefined` is
 *   deliberately not a legal placeholder in `beans`, which is what makes
 *   that check safe for a `null` placeholder.
 * @returns the replacement to serialise.
 *
 * @example
 * ```ts
 * configureRedaction({ placeholder: (_v, { name }) => `<${name} hidden>` });
 * redactedValue("hunter2", { name: "password", source: "user" });
 * // → "<password hidden>"
 * ```
 *
 * @see {@link redactShallow} — key-name redaction, which uses this.
 * @see {@link domainSafeValue} — `ValueObject` redaction, which uses this.
 *
 * @internal
 */
export function redactedValue(
	value: unknown,
	context: IValueObjectContext,
	override?: RedactionPlaceholder,
): unknown {
	const placeholder =
		override !== undefined ? override : redactionConfig().placeholder;

	return typeof placeholder === "function"
		? placeholder(value, context)
		: placeholder;
}
