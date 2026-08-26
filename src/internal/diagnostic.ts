import type { ILogEvent } from "@/types/log-event.interface";

/**
 * Brand marking the line the logger writes about *itself* — currently only the
 * report that a processor threw.
 *
 * Symbol-keyed and non-enumerable, like `FORMATTED`, so it is skipped by
 * `JSON.stringify` and `for…in` and never reaches the serialised output.
 *
 * @internal
 */
const DIAGNOSTIC: unique symbol = Symbol("aroma.diagnostic");

/**
 * Mark an event as the logger's own diagnostic.
 *
 * @param event - the event to brand; returned unchanged.
 *
 * @internal
 */
export function brandAsDiagnostic(event: ILogEvent): ILogEvent {
	Object.defineProperty(event, DIAGNOSTIC, {
		value: true,
		enumerable: false,
	});
	return event;
}

/**
 * Whether this event is the logger reporting its own failure rather than
 * something the application asked to log.
 *
 * @remarks
 * When a processor throws, the diagnostic that replaces the dropped event is
 * run back through the pipeline with only the failing processor removed —
 * that is what keeps it in the same shape as every other line, so a stream of
 * ECS documents stays a stream of ECS documents. The side effect is that every
 * *other* processor sees it too, and a processor kept for its side effects —
 * a metric counter, a sampling budget — will count the logger's own failure
 * alongside real traffic.
 *
 * Excluding it is a decision only the processor's author can make, so this is
 * the hook rather than a default:
 *
 * ```ts
 * import { isDiagnostic } from "@roastery/aroma";
 *
 * const counter: IProcessor = {
 *   name: "metrics",
 *   process(event) {
 *     if (!isDiagnostic(event)) metrics.increment(event.level);
 *     return event;
 *   },
 * };
 * ```
 *
 * The brand does not survive a processor that rebuilds the event from
 * scratch — `createEcsProcessor` returns a fresh object — so check it before
 * any format processor in the pipeline, which is where a side-effecting
 * processor belongs anyway.
 *
 * @param event - the event currently in the pipeline.
 * @returns `true` when the logger produced this line about itself.
 *
 * @since 0.1.0
 *
 * @see {@link IProcessor}
 */
export function isDiagnostic(event: ILogEvent): boolean {
	return (event as unknown as Record<symbol, unknown>)[DIAGNOSTIC] === true;
}
