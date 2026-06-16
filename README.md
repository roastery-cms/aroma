# @roastery/aroma

Structured, transport-based logger for the [Roastery CMS](https://github.com/roastery-cms) ecosystem — a **pino-style** logging core with pluggable **Transports**, **Processors**, async **Context** propagation, and optional **OpenTelemetry** correlation.

[![Checked with Biome](https://img.shields.io/badge/Checked_with-Biome-60a5fa?style=flat&logo=biome)](https://biomejs.dev)

## Overview

**aroma** provides a fast, composable logging core for TypeScript services:

- **Logger** — pino-style call shape (`log.info({ userId }, "msg")`), six levels (`trace` → `fatal`), `child()` context inheritance, and a **zero-allocation dropped path** (calls below the configured level are bound to a shared no-op at construction time).
- **Transports** — pluggable sinks. Buffered non-blocking stdio, rotating files, worker-thread offloading, in-memory capture for tests, or any pino-shaped sink via the compat shim.
- **Processors** — a synchronous pipeline applied once per event before broadcast: redaction, enrichment, filtering, sampling, and ECS remapping.
- **Redaction by default** — common secret keys are masked out of the box; opt out with `redact: false`.
- **Crash-safe** — `error`/`fatal` lines are written **synchronously**, so they survive an immediate `process.exit()`.

## Technologies

| Tool | Purpose |
|------|---------|
| [@roastery/terroir](https://github.com/roastery-cms/terroir) | Exception hierarchy (`AromaException` → `InfraException`) |
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
# Install the library (pulls in @roastery/terroir)
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

Build a logger with `createAroma`. Every option is optional — `createAroma()` returns a working logger that writes JSON to stdout/stderr at `"info"` and above, with default redaction applied.

```typescript
import { createAroma } from "@roastery/aroma";

const log = createAroma();

log.info({ userId: 42 }, "user registered");
// stdout: {"level":"info","time":1700…,"msg":"user registered","bindings":{},"meta":{"userId":42}}

log.info({ password: "x" }, "tried");   // → password redacted by default

const req = log.child({ requestId: "abc-123" });
req.error(new Error("boom"), "checkout failed");
```

### Configuration

```typescript
const log = createAroma({
  level: "info",                 // minimum severity broadcast to transports
  redact: ["customSecret"],      // ADDED to the default keys (or `false` to disable redaction)
  processors: [/* … */],         // run after the auto-injected redact processor
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
| `createRedactProcessor({ keys })` | Masks top-level fields with `"[REDACTED]"` (shallow) |
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

### Redaction

`createAroma` auto-injects a redact processor (unless `redact: false`) using `DEFAULT_REDACT_KEYS`:

```
authorization · cookie · password · token · secret · apiKey · api_key
```

Extra keys passed via `redact: [...]` are **added** to these defaults.

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
  createRedactProcessor, createEnrichProcessor, createFilterProcessor,
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
