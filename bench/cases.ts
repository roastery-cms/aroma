import {
	EmailVO,
	PasswordVO,
	StringVO,
} from "@roastery/beans/domain/collections/value-objects";
import { DomainEvent } from "@roastery/beans/domain/domain-event";
import { Entity } from "@roastery/beans/domain/entity";
import type { EntityDefinition } from "@roastery/beans/domain/entity/types";
import type { BenchCase } from "#bench/harness";
import { CONTROL_CASE_ID, DiscardTransport } from "#bench/harness";
import { createAroma } from "@/create-aroma";
import { AromaException } from "@/exceptions/aroma-exception";
import { serializeEvent } from "@/internal/serializer";
import { Logger } from "@/logger";
import {
	createRedactProcessor,
	DEFAULT_REDACT_KEYS,
} from "@/processors/redact";
import type { ILogEvent } from "@/types/log-event.interface";

/**
 * The scenarios `bun run bench` measures.
 *
 * Each isolates one segment of
 * `makeLevelFn → emit → processors[] → transports[]`, so a regression can be
 * attributed rather than merely observed:
 *
 * - `dropped` guards the zero-allocation path, the headline optimisation;
 * - `core-*` runs a bare `Logger` with **no** processors, so subtracting it
 *   from the matching `aroma-*` case gives the auto-injected `[domain]`
 *   processor's real cost;
 * - `domain-*` covers what the domain processor actually converts;
 * - `redact-optin` is the only case running two visitors in one process, so it
 *   is where a polymorphic walk call site would show up. The process-per-case
 *   split hides that everywhere else.
 *
 * Definitions live apart from the runner because every case is measured in
 * its **own process** — `bench/case-runner.ts` imports this module, picks one
 * case by id and reports it. See `bench/throughput.bench.ts` for why.
 *
 * @see `bench/case-runner.ts` — measures one of these.
 * @see `bench/throughput.bench.ts` — spawns a runner per case and aggregates.
 */

const userProperties = { name: StringVO, email: EmailVO, password: PasswordVO };

class User extends Entity<typeof userProperties> {
	protected defineEntity(): EntityDefinition<typeof userProperties> {
		return { properties: userProperties, source: "user" };
	}
}

class OrderConfirmed extends DomainEvent {
	protected defineName(): string {
		return "order.confirmed";
	}
}

export const sink = new DiscardTransport();

/**
 * The default pipeline: `[domain]` plus the discarding sink.
 *
 * `acknowledgeNoMasking` because measuring the default is the whole point here
 * — without it the startup warning fires once per case process and buries the
 * table it is supposed to be measuring.
 */
const aroma = createAroma({ transports: [sink], acknowledgeNoMasking: true });

/** The same, with key-name masking opted back in — no longer the default. */
const guarded = createAroma({
	transports: [sink],
	processors: [createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS] })],
});

/** Same wiring with the processors removed — the pipeline floor. */
const core = new Logger({ transports: [sink] });

/** Below the `"info"` threshold, so its level method is `NOOP_VOID`. */
const META = { userId: 42, requestId: "01J8Z9", route: "/checkout", ms: 12 };
const SECRET_META = { userId: 42, password: "Sup3rS3cret!", token: "abc123" };

const user = new User({
	name: "alan",
	email: "alan@roastery.dev",
	password: "Sup3rS3cret!",
});
const password = new PasswordVO("Sup3rS3cret!", {
	name: "password",
	source: "user",
});
const users = [
	user,
	new User({
		name: "bob",
		email: "bob@roastery.dev",
		password: "An0therS3cret!",
	}),
];
const domainEvent = new OrderConfirmed(user.toJSON().id);
/** The shape an HTTP service logs constantly — the reason the walk goes deep. */
const DEEP_CLEAN = {
	ctx: {
		request: {
			headers: { accept: "application/json", "user-agent": "bun" },
			method: "POST",
		},
		route: "/checkout",
	},
};
const DEEP_SECRET = {
	ctx: {
		request: {
			headers: { authorization: "Bearer abc", accept: "application/json" },
			method: "POST",
		},
		route: "/checkout",
	},
};

/** An entity below a plain literal: the payload the top-level-only conversion leaked. */
const DEEP_DOMAIN = { ctx: { request: { user } } };

/**
 * Breadth rather than depth. Nesting cost is bounded by the payload; the
 * number of keys the walk has to look at is not, and this is the shape where a
 * consumer would notice the deep conversion.
 */
const WIDE_ROWS = {
	rows: Array.from({ length: 8 }, (_, index) => ({
		id: index,
		sku: `SKU-${index}`,
		qty: index + 1,
		price: 1999,
		currency: "BRL",
		warehouse: "sp-01",
	})),
};

/**
 * The width the node budget exists for, and the shape a consumer would notice.
 * `maxDepth` bounds how deep a payload can take the walk; only this bounds how
 * wide, and the cost is linear — about 9 ns a node either way.
 */
const HUGE_ROWS = {
	rows: Array.from({ length: 200 }, (_, index) => ({
		id: index,
		sku: `SKU-${index}`,
		qty: index + 1,
		price: 1999,
		currency: "BRL",
		warehouse: "sp-01",
	})),
};

/**
 * Deeper than the old bound of 6 and shallower than the new one of 24, with
 * nothing sensitive in it. Nothing else in this file goes past four levels, so
 * without this the cost of raising `MAX_WALK_DEPTH` would be unmeasured — the
 * walk used to stop at 6 and hand the rest back untouched, and now it goes all
 * the way down.
 */
const DEEP_CLEAN_16 = (() => {
	let node: Record<string, unknown> = { leaf: "bottom", n: 0 };
	for (let level = 0; level < 16; level++) {
		node = { nested: node, level, tag: `l${level}` };
	}
	return node;
})();

/**
 * Plain literals carrying their own `toJSON()`, which is the shape door 8
 * moved: they used to be walked property by property and now take the
 * projection branch instead. A response DTO is exactly this.
 */
const DTO_ROWS = {
	rows: Array.from({ length: 8 }, (_, index) => ({
		id: index,
		sku: `SKU-${index}`,
		qty: index + 1,
		toJSON(this: { id: number; sku: string; qty: number }) {
			return { id: this.id, sku: this.sku, qty: this.qty };
		},
	})),
};

/**
 * Class instances, which is the branch that pays for door 7: every object node
 * costs one property load to ask whether it projects through `toJSON()`, and
 * one of these actually does.
 */
class Envelope {
	public constructor(
		public readonly id: number,
		public readonly sku: string,
	) {}
	public toJSON(): unknown {
		return { id: this.id, sku: this.sku };
	}
}

const CLASS_ROWS = {
	rows: Array.from(
		{ length: 8 },
		(_, index) => new Envelope(index, `SKU-${index}`),
	),
	when: new Date(0),
};

const failure = new AromaException("transport down", {
	cause: new Error("EPIPE"),
});

const EVENT: ILogEvent = {
	level: "info",
	time: Date.now(),
	msg: "checkout completed",
	bindings: { service: "checkout-api", environment: "production" },
	meta: META,
};

let contextualLog: (() => void) | undefined;

/** Fixed payload for the control case — nothing in `src` touches it. */
const CONTROL_INPUT = {
	level: "info",
	time: 1_700_000_000_000,
	msg: "checkout completed",
	userId: 42,
};

export const CASES: BenchCase[] = [
	{
		id: CONTROL_CASE_ID,
		label: "control — JSON.stringify of a fixed object (no aroma code)",
		iterations: 2_000_000,
		note: "not a target: it contains none of this package, so a change here means the machine got slower, and `compare.ts` divides that out of every other case before deciding whether anything regressed",
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				JSON.stringify(CONTROL_INPUT);
			}
		},
	},
	{
		id: "dropped",
		label: "log.trace() below threshold (NOOP_VOID)",
		iterations: 100_000_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.trace(META, "never emitted");
			}
		},
	},
	{
		id: "core-msg",
		label: "bare Logger, message only",
		iterations: 1_000_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				core.info("checkout completed");
			}
		},
	},
	{
		id: "core-meta",
		label: "bare Logger, 4-key meta",
		iterations: 1_000_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				core.info(META, "checkout completed");
			}
		},
	},
	{
		id: "aroma-msg",
		label: "createAroma, message only",
		iterations: 500_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info("checkout completed");
			}
		},
	},
	{
		id: "aroma-meta",
		label: "createAroma, 4-key meta (no redact hit)",
		iterations: 500_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info(META, "checkout completed");
			}
		},
	},
	{
		id: "redact-optin",
		label: "createAroma + createRedactProcessor, meta with two masked keys",
		iterations: 200_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				guarded.info(SECRET_META, "user login");
			}
		},
	},
	{
		id: "domain-entity",
		label: "meta carrying an Entity (→ toSafeJSON)",
		iterations: 150_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info({ user }, "user created");
			}
		},
	},
	{
		id: "domain-collection",
		label: "meta carrying an array of entities (per-item descent)",
		iterations: 60_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info({ users }, "listing");
			}
		},
	},
	{
		id: "domain-vo",
		label: "meta carrying a sensitive ValueObject",
		iterations: 150_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info({ password }, "login attempt");
			}
		},
	},
	{
		id: "domain-event",
		label: "meta carrying a DomainEvent (→ flattened)",
		iterations: 150_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info({ event: domainEvent }, "order confirmed");
			}
		},
	},
	{
		id: "deep-miss",
		label: "4-level nested payload, nothing sensitive (lazy clone)",
		iterations: 200_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info(DEEP_CLEAN, "request");
			}
		},
	},
	{
		id: "deep-hit",
		label: "4-level nested payload, authorization masked at the bottom",
		iterations: 150_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				guarded.info(DEEP_SECRET, "request");
			}
		},
	},
	{
		id: "deep-domain",
		label: "entity below two plain literals (the top-level-only leak)",
		iterations: 150_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info(DEEP_DOMAIN, "request");
			}
		},
	},
	{
		id: "deep-literals",
		label: "8 plain 6-key rows — breadth, not depth",
		iterations: 100_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info(WIDE_ROWS, "listing");
			}
		},
	},
	{
		id: "class-rows",
		label:
			"8 class instances with toJSON() plus a Date — the projection branch",
		iterations: 100_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info(CLASS_ROWS, "listing");
			}
		},
	},
	{
		id: "deep-clean-16",
		label:
			"16-level nested payload, nothing sensitive — the raised depth bound",
		iterations: 100_000,
		note: "the row that moves if MAX_WALK_DEPTH is worth what it costs",
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info(DEEP_CLEAN_16, "request");
			}
		},
	},
	{
		id: "dto-rows",
		label: "8 plain literals with their own toJSON() — the widened projection",
		iterations: 100_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info(DTO_ROWS, "listing");
			}
		},
	},
	{
		id: "wide-rows",
		label: "200 plain 6-key rows — the width the node budget guards",
		iterations: 5_000,
		note: "linear in nodes, so this is the row that moves if the walk gets more expensive per node rather than per event",
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.info(HUGE_ROWS, "listing");
			}
		},
	},
	{
		id: "error",
		label: "log.error() with a CoreException + cause",
		iterations: 250_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.error(failure, "transport failed");
			}
		},
	},
	{
		id: "child",
		label: "logger.child({ requestId })",
		iterations: 250_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				aroma.child({ requestId: "01J8Z9" });
			}
		},
	},
	{
		id: "serialize",
		label: "serializeEvent() on a canonical event",
		iterations: 250_000,
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				serializeEvent(EVENT);
			}
		},
	},
	{
		id: "context",
		label: "runWithContext + info (AsyncLocalStorage)",
		iterations: 150_000,
		note: "importing @/context registers a process-wide context reader that every emit then reads; measuring it in its own process is what keeps that cost off the other cases",
		setup: async () => {
			const { runWithContext } = await import("@/context");
			contextualLog = () => {
				runWithContext({ requestId: "01J8Z9" }, () => {
					aroma.info(META, "checkout completed");
				});
			};
		},
		batch: (iterations) => {
			for (let index = 0; index < iterations; index++) {
				contextualLog?.();
			}
		},
	},
];
