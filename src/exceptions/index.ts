/**
 * Barrel for `@roastery/aroma/exceptions`. Surfaces the exception types
 * raised by the logger.
 *
 * @module @roastery/aroma/exceptions
 *
 * @see {@link AromaException}
 * @see {@link BackpressureDropException}
 */

export type { AromaExceptionOptions } from "@/exceptions/aroma-exception";
export {
	AromaException,
	BackpressureDropException,
} from "@/exceptions/aroma-exception";
