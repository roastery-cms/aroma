import type { ILogEvent } from "@/types/log-event.interface";

/**
 * Sequential transformation stage applied to a `ILogEvent` between
 * materialisation and broadcast. Every event passes through the pipeline
 * in declaration order; any processor may return `null` to **drop** the
 * event before it reaches any transport.
 *
 * Processors are the right place for cross-cutting concerns that must be
 * applied **exactly once per event** regardless of how many transports
 * consume it — redaction, contextual enrichment, sampling, severity
 * filtering, format remapping (ECS/OTel), etc. Letting each transport
 * implement these independently invites drift and bugs (one transport
 * forgets to redact and leaks data).
 *
 * @remarks
 * - Prefer **returning a new event object** (all bundled processors do).
 *   The logger does not deep-clone between stages, so returning a fresh
 *   object is cheap. In-place mutation of `meta` / top-level fields is
 *   allowed, but **do not mutate `event.bindings`**: it is `Object.freeze`d
 *   when no async context is active, so an in-place write throws in strict
 *   mode. To change bindings, spread into a new object and return it (see
 *   `createEnrichProcessor`).
 * - A processor that returns `null` **stops the pipeline** — subsequent
 *   processors are not invoked and the event reaches no transport.
 * - Processors are invoked **synchronously**. Async work (e.g., remote
 *   sampling decisions) does not belong here; put it inside a transport.
 *
 * @see {@link createRedactProcessor}
 * @see {@link createEnrichProcessor}
 * @see {@link createFilterProcessor}
 * @see {@link createSampleProcessor}
 */
export interface IProcessor {
	/**
	 * Transform or filter a single event.
	 *
	 * @param event - the event currently in the pipeline.
	 * @returns the transformed event (often the same object, possibly
	 *   mutated), or `null` to drop the event before it reaches any
	 *   transport.
	 */
	process(event: ILogEvent): ILogEvent | null;

	/** Optional identifier for diagnostics; surfaces in error messages and traces. */
	name?: string;
}
