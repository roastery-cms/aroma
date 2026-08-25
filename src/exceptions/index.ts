/**
 * Barrel for `@roastery/aroma/exceptions`. Surfaces the exception types
 * raised by the logger.
 *
 * @module @roastery/aroma/exceptions
 *
 * @see {@link AromaException}
 * @see {@link BackpressureDropException}
 * @see {@link ProcessorFailureException}
 */

export type { AromaExceptionOptions } from "@/exceptions/aroma-exception";
export {
	AromaException,
	BackpressureDropException,
	ProcessorFailureException,
} from "@/exceptions/aroma-exception";
