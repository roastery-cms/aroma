/**
 * Barrel for `@roastery/aroma/compat`. Compatibility shims that let
 * aroma plug into ecosystems built for other loggers.
 *
 * Currently:
 * - `createPinoCompatTransport` — wraps any pino-shaped transport
 *   (`pino-elasticsearch`, `pino-loki`, `pino-datadog`, ...) into an
 *   aroma `ITransport`.
 *
 * @module @roastery/aroma/compat
 *
 * @see {@link createPinoCompatTransport}
 */

export {
	createPinoCompatTransport,
	type PinoCompatibleTransport,
	type PinoCompatOptions,
} from "@/compat/pino";
