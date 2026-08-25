import { beforeEach } from "bun:test";
import { configureRedaction } from "@roastery/beans";

/**
 * Restore the `@roastery/beans` redaction default before every test.
 *
 * `configureRedaction` is module state inside beans, and `bunfig.toml` runs
 * this suite serially — so a spec that changes the placeholder and forgets to
 * put it back does not fail itself, it fails whichever spec runs next, far
 * from the cause. A preloaded `beforeEach` makes that impossible to forget:
 * specs that deliberately change the configuration keep their own `afterEach`
 * for clarity, but no longer carry the whole suite's isolation on their own.
 */
beforeEach(() => {
	configureRedaction();
});
