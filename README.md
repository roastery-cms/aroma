# @roastery/aroma

Structured, transport-based logger for the [Roastery CMS](https://github.com/roastery-cms) ecosystem — a **pino-style** logging core with pluggable **Transports**, **Processors**, async **Context** propagation, and optional **OpenTelemetry** correlation.

[![Checked with Biome](https://img.shields.io/badge/Checked_with-Biome-60a5fa?style=flat&logo=biome)](https://biomejs.dev)

## Overview

**aroma** provides a fast, composable logging core for TypeScript services:

- **Logger** — pino-style call shape (`log.info({ userId }, "msg")`), six levels (`trace` → `fatal`), `child()` context inheritance, and a **zero-allocation dropped path** (calls below the configured level are bound to a shared no-op at construction time).
- **Transports** — pluggable sinks. Buffered non-blocking stdio, rotating files, worker-thread offloading, in-memory capture for tests, or any pino-shaped sink via the compat shim.
- **Processors** — a synchronous pipeline applied once per event before broadcast: redaction, enrichment, filtering, sampling, and ECS remapping.
- **Domain safety by default** — `@roastery/beans` objects are serialised through their *safe* form at any depth, so a `sensitive` property can't slip out below a harmless key. Masking by field name is a one-line opt-in (`createRedactProcessor`), because the domain layer, not the logger, is what knows a field is secret.
- **Crash-safe** — `error`/`fatal` lines are written **synchronously**, so they survive an immediate `process.exit()`.

## Technologies

| Tool | Purpose |
|------|---------|
| [@roastery/terroir](https://github.com/roastery-cms/terroir) | Exception hierarchy (`AromaException` → `InfraException`) |
| [@roastery/beans](https://github.com/roastery-cms/beans) | Domain pillars (`Entity`, `ValueObject`, `Command`, domain events) made safe to log, and the shared redaction placeholder |
| [@opentelemetry/api](https://github.com/open-telemetry/opentelemetry-js) | Optional trace/span correlation (`@roastery/aroma/otel`) |
| [tsup](https://tsup.egoist.dev) | Bundling to ESM + CJS with `.d.ts` generation |
| [Bun](https://bun.sh) | Runtime, test runner, and package manager |
| [Knip](https://knip.dev) | Unused exports and dependency detection |
| [Biome](https://biomejs.dev) | Linting and formatting |
| [Husky](https://typicode.github.io/husky) + [commitlint](https://commitlint.js.org) | Git hooks and conventional commit enforcement |

## Installation

Install the package and its peer dependency:

```bash
bun add @roastery/aroma typescript
```

Or install them separately:

```bash
# Install the library (pulls in @roastery/terroir and @roastery/beans)
bun add @roastery/aroma

# Install the peer dependency
bun add -d typescript

# Optional — only needed for the @roastery/aroma/otel subpath
bun add @opentelemetry/api
```

### Local development (link)

If you're developing `aroma` alongside another project, you can link it locally:

```bash
# Inside the aroma directory
bun run setup  # builds and registers the link

# Inside your consuming project
bun link @roastery/aroma
```

---

## Logger

Build a logger with `createAroma`. Every option is optional — `createAroma()` returns a working logger that writes JSON to stdout/stderr at `"info"` and above, with `@roastery/beans` domain objects converted to their safe form.

```typescript
import { createAroma } from "@roastery/aroma";

const log = createAroma();

log.info({ userId: 42 }, "user registered");
// stdout: {"level":"info","time":1700…,"msg":"user registered","bindings":{},"meta":{"userId":42}}

log.info({ user }, "created");          // → entity via toSafeJSON(); sensitive fields masked
log.info({ password: "x" }, "tried");   // → written as-is; see "Masking by field name"

const req = log.child({ requestId: "abc-123" });
req.error(new Error("boom"), "checkout failed");
```

### Configuration

```typescript
const log = createAroma({
  level: "info",                 // minimum severity broadcast to transports
  processors: [/* … */],         // run after the auto-injected domain processor
  transports: [/* … */],         // defaults to a single FastStdioTransport
  onError: (err) => telemetry.record("logger.failure", err),
});
```

### Call shapes

The first argument is parsed at runtime; the optional `msg` comes second.

| Call | Meaning |
|------|---------|
| `log.info("event happened")` | message only |
| `log.info({ userId: 42 }, "registered")` | `meta` + message |
| `log.info({ event: "queue.empty" })` | msg-less; all data in `meta` |
| `log.error(err, "checkout failed")` | `Error` as first arg |
| `log.error({ err, step: "auth" }, "failed")` | `Error` inside a `meta.err` key |

Levels, least to most severe: `trace` · `debug` · `info` · `warn` · `error` · `fatal`. `log.log(...)` emits at the logger's configured default level.

### Graceful shutdown

`error`/`fatal` reach the kernel synchronously, but buffered `info`/`warn` lines need an explicit drain:

```typescript
async function shutdown(): Promise<void> {
  await log.flush();   // drain buffered transports (e.g. FastStdioTransport)
  await log.close();   // release file handles, sockets, worker threads
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

---

## Transports

A transport receives fully-built, already-redacted `ILogEvent`s and decides where they go. The logger broadcasts fire-and-forget; a rejected write is surfaced through `onError` as an `AromaException` and never blocks peer transports or the caller.

| Class | Description |
|-------|-------------|
| `FastStdioTransport` | Buffered, non-blocking stdio writer — one syscall per buffer-fill. **The default.** |
| `FileTransport` | Persistent file writer with size/interval rotation and optional gzip |
| `WorkerTransport` | Offloads a sink (e.g. a `FileTransport`) to a worker thread |
| `ConsoleTransport` | Direct stream writer (one write per event); kept for compatibility |
| `NullTransport` | In-memory capture for tests (`transport.events`) |

```typescript
import { FastStdioTransport, FileTransport } from "@roastery/aroma/transports";
import { createAroma } from "@roastery/aroma";

const log = createAroma({
  transports: [
    new FastStdioTransport({ bufferSize: 8 * 1024, backpressure: "drop" }),
    new FileTransport({
      path: "/var/log/app.log",
      rotation: { size: "50MB", interval: "daily" },
      compress: "gzip",
    }),
  ],
});
```

### Worker transport

Offload I/O to a worker thread. A ready-made file worker ships at `@roastery/aroma/transports/worker/file-worker`:

```typescript
import { WorkerTransport } from "@roastery/aroma/transports";

const transport = new WorkerTransport({
  target: require.resolve("@roastery/aroma/transports/worker/file-worker"),
  targetOptions: { path: "/var/log/app.log", rotation: { size: "10MB" } },
  onError: (err) => console.error("worker err:", err),
});
```

### Backpressure

Buffered transports (`FastStdioTransport`, `FileTransport`) cap in-memory bytes at `maxBuffered` and apply a policy when saturated:

| Policy | Behavior |
|--------|----------|
| `"drop"` *(default)* | Discards the line, increments the drop count, fires `onDrop` |
| `"sample"` | Keeps roughly 1 in 10 lines under sustained saturation |
| `"block"` | Never drops — buffers the overflow line and may grow past `maxBuffered` (does **not** block the calling thread) |

---

## Processors

Processors run **synchronously, in declaration order**, once per event before any transport sees it. Returning `null` drops the event from the pipeline.

| Factory | Description |
|---------|-------------|
| `createDomainProcessor()` | Replaces `@roastery/beans` domain objects with their safe form — injected automatically, runs **first** |
| `createRedactProcessor({ keys })` | Masks fields by name at any depth with the configured placeholder, `"[redacted]"` by default — **opt-in** |
| `createEnrichProcessor(extras)` | Merges fixed fields into every event's `bindings` |
| `createFilterProcessor(predicate)` | Drops events failing a predicate |
| `createSampleProcessor(rates)` | Probabilistically drops events per-level |
| `createEcsProcessor()` | Remaps the event into Elastic Common Schema — run **last** |

```typescript
import { createAroma } from "@roastery/aroma";
import {
  createEnrichProcessor,
  createSampleProcessor,
  createEcsProcessor,
} from "@roastery/aroma/processors";

const log = createAroma({
  processors: [
    createEnrichProcessor({ service: "checkout-api", environment: process.env.NODE_ENV }),
    createSampleProcessor({ trace: 0.01, debug: 0.1 }),
    createEcsProcessor(), // format-final: emits @timestamp / log.level / message / error.*
  ],
});
```

### Safety

`createAroma` auto-injects **one** processor, ahead of yours — the final pipeline is `[domain, ...processors]`.

**The domain processor** converts `@roastery/beans` objects found anywhere in `bindings`/`meta`:

| Value | Becomes |
|-------|---------|
| `Entity`, `DomainRecord`, `arrayOf`/`optionalOf`/`nullableOf` wrapper | `toSafeJSON()` |
| `Command` | `toJSON()` — already redacted by `beans` |
| `ValueObject` with `sensitive: true` | the redaction placeholder |
| any other `ValueObject` | its raw `.value`, unwrapped |
| domain event (top level) | flattened `event.name` / `event.aggregateId` / `event.occurredAt` / `event.payload` keys |
| domain event (deeper) | a nested `{ name, aggregateId, occurredAt, payload? }` object |
| `Array` / `Map` / `Set` | descended into (a `Map` becomes an object, a `Set` an array — otherwise `JSON.stringify` emits `{}`) |

This matters because `Entity.toJSON()` is the *persistence* contract — lossless and deliberately unredacted — and `JSON.stringify` calls exactly that. Without this stage, `log.info({ user }, "created")` writes the password out.

Scope is **deep** (6 levels): a domain object is converted wherever it sits — below a plain literal, inside a collection, or inside an ordinary class instance. Recursion *inside* a domain object remains `toSafeJSON`'s own job.

The walk enters everything except binary (`Uint8Array`, `Buffer`, `DataView`). That sounds broad and is not: `Object.keys` returns only own enumerable properties, so a getter declared on a class is never invoked, and `Date`, `Error`, `Promise`, `URL` and `RegExp` have none at all and come back untouched. Width is bounded too — 10.000 objects per walk, past which subtrees are replaced by `"[truncated: node budget]"` rather than passed through unconverted.

A class instance with its own `toJSON()` is followed through it, because that is what `JSON.stringify` will emit — otherwise a DTO holding a domain object in a `#private` field would show the walk nothing and serialise the entity raw. If the projection holds nothing of ours, the original object is handed back untouched, so a `Date` stays a `Date`.

The same conversion covers the three routes a processor cannot see on its own:

- **`err.cause`** — `serializeError` runs before the pipeline, and terroir encourages putting the original failure in `cause`, so the conversion happens inside the error serialiser.
- **A domain object passed as `meta` itself** — `log.info(user, "created")` is converted before the spread. Without that the entry is not leaked but *emptied*: a spread copies symbol keys, `JSON.stringify` drops them, and the line reads `"meta":{}`.
- **An instance from a second copy of `@roastery/beans`** — `instanceof` fails across duplicated packages, so detection also matches structurally (`toSafeJSON`, and `defineMeta` for value objects).

There is no argument that turns this off. A logger that converts nothing is `new Logger({ transports: [...] })` — and note that a live domain instance then **cannot cross a `WorkerTransport` boundary**, because structured clone keeps only own enumerable string keys and an entity keeps its state under symbols, so it arrives as `{}`.

### Masking by field name — opt-in

**Nothing is masked by field name unless you ask.** The domain layer knows which of *its* fields are sensitive; a key list inside the logger duplicates that knowledge imperfectly and charges every event for the privilege. So these all reach the log as written:

```typescript
log.info({ password: "hunter2" }, "signup");                          // written out
log.info({ req: { headers: { authorization: "Bearer …" } } }, "req"); // written out
log.info({ stripe: { token: "tok_…" } }, "charged");                  // written out
```

None of those is a domain object, and none ever will be — a Node request belongs to Node, a Stripe response to Stripe, and a DTO at the edge has not been validated into value objects yet. That is exactly where you want the key-name processor:

```typescript
import { createAroma } from "@roastery/aroma";
import { createRedactProcessor, DEFAULT_REDACT_KEYS } from "@roastery/aroma/processors";

const log = createAroma({
  processors: [createRedactProcessor({ keys: [...DEFAULT_REDACT_KEYS, "customSecret"] })],
});
```

`DEFAULT_REDACT_KEYS` is a starting list, not a default:

```
authorization · cookie · password · token · secret · apiKey · api_key
```

Keys match by **name at any depth** (24 levels, the same bound the domain conversion uses); dot-path *targeting* (`"user.password"`) is not interpreted. Unlike the domain conversion, this walk leaves a subtree past its bound **alone** rather than truncating it: masking is a heuristic over a payload the conversion has already made safe, so a key it never reached is unmasked and nothing worse. `err.cause` is traversed too, so a plain object handed to `new BadRequestException(…, { cause })` is covered; `err`'s own `name`/`message`/`stack`/`source`/`layer`/`code` are never touched.

```typescript
createRedactProcessor({ keys: ["customSecret"], maxDepth: 1 });  // top level only
```

> **Upgrading from 0.0.3?** This is the breaking change to look at. `createAroma()` used to apply `DEFAULT_REDACT_KEYS` for you; it no longer does, and there is no compile error to catch it if you never passed the `redact` option. The snippet above restores the old behaviour exactly.
>
> Because nothing in the type system can reach you, the logger says so itself at startup — once per process, on **stderr** and as one `warn` line on the **log stream**. Two channels because neither alone reaches everyone: stderr works when the logger is not up, and the stream is what an operator actually collects. Silence both when the choice is deliberate:
>
> ```typescript
> createAroma({ acknowledgeNoMasking: true });
> ```

### How deep the conversion goes

The domain conversion descends 24 levels into `bindings`, `meta` and `err.cause`. Past that it substitutes a marker rather than letting the subtree through:

```json
{"meta":{"root":{"nested":{"…":"[truncated: depth]"}}}}
```

That direction is not negotiable — a subtree the walk did not enter may hold a `beans` object, and handing it back unconverted is exactly the leak the walk exists to prevent. What *is* yours to choose is where the line sits:

```typescript
createAroma({ maxDepth: 32 });   // an integer in 1..64
```

It is validated at construction, not clamped: a bound you did not get is worse than an error you did. A `child` inherits it.

The same rule covers a payload that is merely enormous rather than deep — the walk enters at most 10.000 objects per event, and substitutes `"[truncated: node budget]"` at the door of the first one past that. Neither guard fires on a log line anyone meant to write.

A DTO carrying its own `toJSON()` is followed rather than read property by property, because `toJSON()` is what the serialiser will emit. If the projection contains nothing of ours, the object comes back **by identity** — a `Date` stays a `Date` for a transport reading the raw event.

### When a processor fails

A processor that throws never reaches your call site. The failure is wrapped in a `ProcessorFailureException` delivered to `onError`, and a diagnostic line naming the processor goes to the transports — run through the pipeline with **only the failing processor removed**, so it cannot take down the report of its own failure while a format processor like `createEcsProcessor` still shapes it.

The event in flight is **discarded**. A processor that failed midway leaves it indeterminate — possibly still holding what a conversion had not finished converting — and forwarding that would turn a processor failure into the leak it exists to prevent. One lost line beats one leaked secret.

A processor that fails on *every* event gets **one diagnostic line per second per failure message**, with the swallowed count on the next one. `onError` still fires every time — it is your telemetry hook, not the log stream.

That diagnostic runs through your pipeline, so your own processors see it. If one of them has side effects — a metric counter, a sampling budget — exclude it:

```typescript
import { isDiagnostic } from "@roastery/aroma";

const counter: IProcessor = {
  name: "metrics",
  process(event) {
    if (!isDiagnostic(event)) metrics.increment(event.level);
    return event;
  },
};
```

And a payload that fights back — a getter that throws, a hostile `Proxy` trap — costs the record it was in, never the line and never your call site.

#### The placeholder

The replacement value comes from `@roastery/beans`, so one call governs the logger and the domain layer alike:

```typescript
import { configureRedaction } from "@roastery/beans";

configureRedaction({ placeholder: "***" });

// or compute it — this is how partial masking works
configureRedaction({
  placeholder: (value, { name, source }) => `<${source}.${name} hidden>`,
});
```

It defaults to `"[redacted]"`. When the logger masks by key name, the context is `{ name: <the key>, source: "@roastery/aroma" }`; when it redacts a sensitive `ValueObject`, the context is the value-object's own — whose `source` is the owning aggregate.

---

## Context

AsyncLocalStorage-backed propagation. Importing `@roastery/aroma/context` activates the integration — the core lazy-detects the store at emit time, so it stays runtime-agnostic until you opt in.

```typescript
import { createAroma } from "@roastery/aroma";
import { runWithContext, getContext } from "@roastery/aroma/context";

const log = createAroma();

app.use((req, _res, next) => {
  runWithContext({ requestId: req.id, route: req.path }, () => {
    log.info("request received"); // event.bindings carries requestId + route
    next();
  });
});
```

Context bindings **win over** the logger's own `bindings` on key collision (narrower scope overrides broader scope).

---

## OpenTelemetry

Opt-in trace correlation. `@opentelemetry/api` is an optional peer dependency; importing this subpath does not pull it into the core bundle.

```typescript
import { createAroma } from "@roastery/aroma";
import { createOtelProcessor, primeOtel } from "@roastery/aroma/otel";

await primeOtel(); // resolve the lazy import once at boot — then reads are synchronous

const log = createAroma({ processors: [createOtelProcessor()] });
// Inside an active span, events automatically carry trace_id / span_id / trace_flags.
```

---

## Compat

Reuse the pino transport ecosystem (`pino-elasticsearch`, `pino-loki`, `pino-datadog`, …) without rewriting code:

```typescript
import { createAroma } from "@roastery/aroma";
import { createPinoCompatTransport } from "@roastery/aroma/compat";
import pinoElastic from "pino-elasticsearch";

const elastic = pinoElastic({ index: "app", node: "https://es:9200" });

const log = createAroma({
  transports: [createPinoCompatTransport(elastic, { name: "elastic" })],
});
```

---

## Exceptions

| Class | Raised when |
|-------|-------------|
| `AromaException` | A transport's `write` rejects (delivered to `onError`) |
| `BackpressureDropException` | A buffered transport drops events under the `"drop"` policy (carries `dropCount`) |

```typescript
import { createAroma } from "@roastery/aroma";
import { BackpressureDropException } from "@roastery/aroma/exceptions";

createAroma({
  onError: (err) => {
    if (err instanceof BackpressureDropException) {
      metrics.increment("logger.drops", { count: err.dropCount });
    }
  },
});
```

---

## Testing

Attach a `NullTransport` and assert on the captured events — no need to await anything:

```typescript
import { Logger } from "@roastery/aroma";
import { NullTransport } from "@roastery/aroma/transports";

const sink = new NullTransport();
const log = new Logger({ transports: [sink] });

log.info({ userId: 42 }, "user registered");

expect(sink.events[0]?.level).toBe("info");
expect(sink.events[0]?.meta).toEqual({ userId: 42 });
```

---

## Exports reference

```typescript
// Top-level
import { createAroma, Logger } from "@roastery/aroma";
import type { CreateAromaArgs, LoggerOptions } from "@roastery/aroma";

// Types & contracts
import { LEVEL_NUMERIC } from "@roastery/aroma/types";
import type {
  ILogger, ITransport, IProcessor, ILogEvent, LogLevel, Bindings,
} from "@roastery/aroma/types";

// Transports
import {
  FastStdioTransport, FileTransport, WorkerTransport, ConsoleTransport, NullTransport,
} from "@roastery/aroma/transports";

// Bundled worker entry (target for WorkerTransport)
// @roastery/aroma/transports/worker/file-worker

// Processors
import {
  createDomainProcessor, createRedactProcessor, DEFAULT_REDACT_KEYS,
  createEnrichProcessor, createFilterProcessor,
  createSampleProcessor, createEcsProcessor,
} from "@roastery/aroma/processors";

// Context (AsyncLocalStorage propagation)
import { runWithContext, getContext } from "@roastery/aroma/context";

// OpenTelemetry correlation (optional peer: @opentelemetry/api)
import { createOtelProcessor, getActiveTraceContext, primeOtel } from "@roastery/aroma/otel";

// pino transport compat
import { createPinoCompatTransport } from "@roastery/aroma/compat";

// Exceptions
import { AromaException, BackpressureDropException } from "@roastery/aroma/exceptions";
```

---

## Development

```bash
# Run tests
bun run test:unit

# Run tests with coverage
bun run test:coverage

# Throughput benchmarks
bun run bench

# Build for distribution (Biome + Knip + tsup)
bun run build

# Check for unused exports and dependencies
bun run knip

# Full setup (build + bun link)
bun run setup
```

## License

MIT
