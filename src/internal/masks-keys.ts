import type { IProcessor } from "@/types/processor.interface";

/**
 * Brand marking a processor that masks fields by **name**.
 *
 * A symbol rather than a `name === "redact"` comparison: `name` is a free-form
 * diagnostic label a consumer may reuse or rename, and this decides whether to
 * warn someone that their secrets are going out in the clear. It should not
 * hinge on a string.
 *
 * @internal
 */
const MASKS_KEYS: unique symbol = Symbol("aroma.masks-keys");

/**
 * Mark a processor as masking by field name, so `createAroma` can tell whether
 * a pipeline has that half of log safety in it.
 *
 * Non-enumerable, like the other brands in this package, so it never shows up
 * in a spread or a serialisation of the processor object.
 *
 * @param processor - the processor to brand; returned unchanged.
 *
 * @internal
 */
export function brandAsMasking(processor: IProcessor): IProcessor {
	Object.defineProperty(processor, MASKS_KEYS, {
		value: true,
		enumerable: false,
	});
	return processor;
}

/** Whether `processor` masks fields by name. */
function masksKeys(processor: IProcessor): boolean {
	return (processor as unknown as Record<symbol, unknown>)[MASKS_KEYS] === true;
}

/** Once per process, not once per logger — see {@link claimMaskingWarning}. */
let warned = false;

/**
 * Set the once-per-process latch directly. Tests only.
 *
 * @remarks
 * The flag is module state and the suite runs serially, so it cuts both ways.
 * A spec that means to observe the warning has to clear the latch first
 * (`false`), or whichever spec ran earlier would have consumed it and this one
 * would pass without asserting anything. Every *other* spec wants it already
 * claimed (`true`), because half the warning now goes out on the log stream and
 * would otherwise land in a sink some unrelated assertion is reading — which
 * is what `test/claim-masking-warning.ts` does once, before any spec runs.
 *
 * @param claimed - the latch's new state.
 *
 * @internal
 */
export function _setMaskingWarningClaimed(claimed: boolean): void {
	warned = claimed;
}

/** The one-line form, for the log stream. */
export const MASKING_WARNING_MSG = "this logger does not mask fields by name";

/** The full form, for stderr, where there is room to say what to do about it. */
const MASKING_WARNING_TEXT =
	"[@roastery/aroma] This logger does not mask fields by name.\n" +
	"  @roastery/beans domain objects are still converted through toSafeJSON(),\n" +
	"  but a plain { password }, a request's authorization header and a\n" +
	"  third-party token are written out as they are.\n" +
	"  To mask them:\n" +
	"    import { createRedactProcessor, DEFAULT_REDACT_KEYS } from '@roastery/aroma/processors';\n" +
	"    createAroma({ processors: [createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] })] });\n" +
	"  To silence this: createAroma({ acknowledgeNoMasking: true }).";

/**
 * Claim the one warning this process gets about a pipeline with no key-name
 * masking, writing it to stderr and reporting whether the caller should also
 * put it on the log stream.
 *
 * @remarks
 * Dropping the `redact` option from `createAroma` makes a stale
 * `redact: ["…"]` or `redact: false` fail to compile, which covers everyone who
 * *configured* redaction. It does not cover anyone who never passed the option
 * — which is the majority, and precisely the people who were relying on the
 * default. For them, moving off 0.0.3 turns `{ password: "[redacted]" }` into
 * `{ password: "hunter2" }` with no type error, no exception and no test
 * failure.
 *
 * Two channels, because neither alone reaches everyone. stderr is the one that
 * works when the logger is not up, or is pointed somewhere odd; the log stream
 * is the one an operator actually collects, and a service that discards stderr
 * — most containerised ones do something like it — would never have seen the
 * warning at all. The latch is shared, so it is one warning per process across
 * both, silenced for good by `acknowledgeNoMasking`.
 *
 * @param processors - the final pipeline, already assembled.
 * @param acknowledged - the caller has declared the choice.
 * @returns `true` when the warning was claimed and should also be logged.
 *
 * @internal
 */
export function claimMaskingWarning(
	processors: ReadonlyArray<IProcessor>,
	acknowledged: boolean,
): boolean {
	if (warned || acknowledged) {
		return false;
	}

	for (const processor of processors) {
		if (masksKeys(processor)) {
			return false;
		}
	}

	warned = true;
	console.warn(MASKING_WARNING_TEXT);
	return true;
}
