/**
 * Brand marking an event whose structure has already been remapped into a
 * final wire shape by a **format processor** (e.g. `createEcsProcessor`, or
 * a future GELF / logfmt mapper). The canonical fast path in
 * {@link serializeEvent} only understands the `ILogEvent` shape and would
 * silently drop any unrecognised top-level keys; when a processor reshapes
 * the event it stamps it with this symbol so the serializer emits the
 * object faithfully via `JSON.stringify` instead.
 *
 * Symbol keys are skipped by both `JSON.stringify` and `for…in`, so the
 * brand never leaks into the serialised output line.
 *
 * @internal
 */
export const FORMATTED: unique symbol = Symbol("aroma.formatted");

/**
 * Type guard: has this event been stamped by a format processor and should
 * therefore be serialised as-is rather than via the canonical fast path?
 *
 * @param event - the event currently leaving the pipeline.
 * @returns `true` when the event carries the {@link FORMATTED} brand.
 *
 * @internal
 */
export function isFormatted(event: object): boolean {
	return (event as Record<symbol, unknown>)[FORMATTED] === true;
}
