/**
 * Shared do-nothing function bound onto every `Logger` method whose level
 * is below the configured threshold. Using a single module-level constant
 * (instead of allocating a fresh closure per instance) keeps the cost of
 * the dropped-log path at exactly **zero allocations and one function
 * call**.
 *
 * @internal
 */
export const NOOP_VOID = (): void => {};
