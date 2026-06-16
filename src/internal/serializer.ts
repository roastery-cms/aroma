import { isFormatted } from "@/internal/formatted";
import { safeStringify } from "@/internal/safe-stringify";
import type { ILogEvent } from "@/types/log-event.interface";

/**
 * Serialise an `ILogEvent` to a single line of JSON, fast-pathing the
 * common shapes:
 *
 * - Events stamped by a **format processor** (carrying the `FORMATTED`
 *   brand — e.g. `createEcsProcessor`) are emitted as-is via the record
 *   stringifier, so their remapped keys survive instead of being dropped
 *   by the canonical fast path.
 * - Empty `bindings`/`meta` skip the `JSON.stringify` call entirely
 *   (literal `"{}"` substituted).
 * - Missing `msg`/`meta`/`err` skip the corresponding key.
 * - Cycles in `bindings`/`meta` are caught and rerouted through
 *   `safeStringify` (the slow fallback) instead of throwing.
 *
 * Output is **not** terminated by `\n` — callers responsible for line
 * framing (e.g. `BufferedWriter`) append it themselves.
 *
 * @param event - the event to serialise.
 * @returns JSON-encoded line representing the event.
 *
 * @internal
 */
export function serializeEvent(event: ILogEvent): string {
	if (isFormatted(event)) {
		return stringifyRecord(event as unknown as Record<string, unknown>);
	}

	const parts: string[] = [];
	parts.push(`"level":"${event.level}"`);
	parts.push(`"time":${event.time}`);
	if (event.msg !== undefined) {
		parts.push(`"msg":${JSON.stringify(event.msg)}`);
	}
	parts.push(`"bindings":${stringifyRecord(event.bindings)}`);
	if (event.meta !== undefined) {
		parts.push(`"meta":${stringifyRecord(event.meta)}`);
	}
	if (event.err !== undefined) {
		parts.push(
			`"err":${stringifyRecord(event.err as Record<string, unknown>)}`,
		);
	}
	return `{${parts.join(",")}}`;
}

function stringifyRecord(value: Record<string, unknown>): string {
	// Empty-object fast path — avoids constructing a stringifier state machine.
	let hasKey = false;
	for (const _key in value) {
		hasKey = true;
		break;
	}
	if (!hasKey) return "{}";

	try {
		return JSON.stringify(value);
	} catch {
		// Cycles or BigInt → safe fallback (`safeStringify` coerces BigInt to a
		// string). Symbol values never reach here — `JSON.stringify` drops them
		// upstream without throwing.
		return safeStringify(value);
	}
}
