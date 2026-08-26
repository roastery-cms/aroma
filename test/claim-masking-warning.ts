import { _setMaskingWarningClaimed } from "@/internal/masks-keys";

/**
 * Claim the process's one "this logger does not mask fields by name" warning
 * before any spec runs.
 *
 * Half of that warning goes out on the log stream, so the first `createAroma`
 * in the process puts a `warn` line into its own transport — and any spec that
 * happens to be first and reads `sink.events[0]` would be asserting against the
 * logger's own startup notice instead of the event it just emitted. The specs
 * that exist to observe the warning clear the latch themselves.
 */
_setMaskingWarningClaimed(true);
