# Atualizar `@roastery/aroma` para `terroir` 0.2.2 + integração com `beans` 0.6.0

## Context

O working tree já aponta `package.json` para `@roastery/terroir` `^0.2.2` e `@roastery/beans` `^0.6.0`, mas
o código de `src/` ainda fala a API 0.1.0. Hoje `bunx tsc --noEmit` falha com 3 erros — o build está quebrado.

O terroir 0.2.0 moveu e renomeou o símbolo do discriminador de camada (`ExceptionLayer` → `Layer`), deu a toda
exceção um slot `ErrorOptions` nativo e passou a expor o status HTTP em `ApplicationException.code`.

### Posição do aroma na pilha

`terroir` e `beans` são os pilares do Roastery. A pilha é **terroir → beans → aroma → barista**: o aroma é uma
camada *acima* do beans, não uma dependência transversal dele. Um framework existe para que suas bibliotecas se
conheçam; tratar o beans como algo a ser evitado por duck-typing seria fugir de um acoplamento que é a razão de
o conjunto ser um framework. Logo **`@roastery/beans` fica em `dependencies`**, como já está no working tree, e
a integração é direta: `instanceof`, tipos reais e a configuração de redação do beans lida de fato.

O que essa integração fecha é um vazamento concreto:

- `Entity.toJSON()` e `DomainRecord.toJSON()` retornam a forma **lossless e não redigida** — é o contrato de
  persistência, e é assim de propósito (`beans/src/domain/entity/entity.ts:557`).
- `serializeEvent` → `stringifyRecord` (`src/internal/serializer.ts:50`), `safeStringify` e o
  `ConsoleTransport` do aroma serializam via `JSON.stringify`, que chama exatamente `toJSON()`.
- Logo, **`log.info({ user }, "criado")` grava a senha em claro no log hoje**. O redact processor do aroma
  não protege: ele é shallow sobre as chaves de topo, e a chave de topo aqui é `user`, que não é sensível —
  o vazamento está um nível abaixo.
- `ValueObject` não tem `toSafeJSON` e expõe `public readonly value` enumerável
  (`beans/src/domain/value-object/value-object.ts:49`), então um `PasswordVO` logado direto vira
  `{"value":"senha"}`.
- `Command.toJSON()` **já** redige (`beans/src/application/command/command.ts:262`) — esse caminho é seguro, e o
  TSDoc dele diz explicitamente que é por causa de "um logger estruturado alcançando via `JSON.stringify`". A
  `Entity` deliberadamente não faz o mesmo, porque `toJSON` é o contrato de persistência dela. A lacuna não é
  descuido do beans: é a metade que só o lado do logger pode fechar.

**Resultado pretendido:** build verde no terroir 0.2.2, e um logger que não pode vazar um campo `sensitive`
de um objeto de domínio — mesmo que o call site esqueça de redigir.

---

## Parte A — Migração obrigatória (o build quebra sem isto)

### A1. `ExceptionLayer` → `Layer`

O subpath `@roastery/terroir/exceptions/symbols` não existe mais. Símbolos comparam por referência, então só
mudam o import e o identificador.

```diff
- import { ExceptionLayer } from "@roastery/terroir/exceptions/symbols";
+ import { Layer } from "@roastery/terroir/symbols";
...
- layer: exc[ExceptionLayer],
+ layer: exc[Layer],
```

Sites:
- `src/internal/serialize-error.ts:3,74`
- `src/exceptions/aroma-exception.spec.ts:4,36`
- `src/exceptions/aroma-exception.ts:29` — apenas menção no TSDoc; atualizar o texto.

Isso também resolve o `TS7053` em `serialize-error.ts:74`, que é consequência do import não resolvido.

`CoreException`, `CoreExceptionType` (`exceptions/core`), `UnknownException` (`exceptions`) e `InfraException`
(`exceptions/models`) mantêm caminho e forma — nada mais a fazer. O aroma não usa `Schema`, o submódulo JWT nem
`RoasteryExceptionRecords`, então §A2–A4 do `MIGRATION.md` do terroir não se aplicam.

---

## Parte B — Simplificações que o terroir 0.2.x habilita

### B1. `AromaException` passa a usar o `ErrorOptions` nativo

Toda exceção concreta do terroir agora aceita um `ErrorOptions` final. `AromaException`
(`src/exceptions/aroma-exception.ts:56`) atribui `this.cause` à mão depois do `super`, o que deixa o slot
vazio durante a construção.

```diff
  public constructor(message: string, options: AromaExceptionOptions = {}) {
-     super(message);
+     super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
      this.message = message;
      this.source = options.source ?? "@roastery/aroma";
-     if (options.cause !== undefined) {
-         this.cause = options.cause;
-     }
  }
```

`BackpressureDropException` herda a mudança sem alteração própria.

### B2. `err.code` — o status HTTP passa a aparecer no log

O `CHANGELOG.md` de 0.0.2 registra que own-properties como `err.code` foram deixadas de fora **de propósito**,
por serem campos ad-hoc. Essa premissa mudou: `ApplicationException.code` agora é um campo **abstrato e
canônico** da hierarquia (`terroir/src/exceptions/models/application-exception.ts:63`), declarado por cada uma
das 41 classes de aplicação. Carregá-lo é preservar a hierarquia, não abrir exceção para um campo arbitrário.

- `src/types/log-event.interface.ts` — adicionar ao objeto `err`:
  `/** Status HTTP quando a exceção é da camada de aplicação; ausente nas demais. */ code?: number;`
- `src/internal/serialize-error.ts` — em `fromCoreException`, emitir `code` quando a exceção for uma
  `ApplicationException`. Com o terroir em `dependencies`, o `instanceof` é direto e tipado.
- O campo é opcional e aditivo: `stringifyRecord` já serializa `err` inteiro, sem mudanças no serializer.

---

## Parte C — Integração com `beans`

`@roastery/beans` permanece em `dependencies`. Os imports usam os **subpaths estreitos** (`/domain/entity`,
`/domain/value-object`, `/domain/record`, `/domain/domain-event`, `/application/command`) em vez do barrel
raiz, para que o custo de carga do logger não inclua pilares que ele não toca.

### C1. `src/internal/domain-safe.ts` (novo, `@internal`)

Converte um valor de domínio na sua forma segura. Regras, na ordem:

| Detecção | Ação | Cobre |
|---|---|---|
| `instanceof ValueObject` | se `[Meta].sensitive === true`, devolve o placeholder resolvido (§C4); senão devolve `value.value` cru (unwrap) | `ValueObject` e subclasses |
| `instanceof Entity` / `instanceof DomainRecord` | `toSafeJSON()` | agregados e records |
| `instanceof Command` | `toJSON()` — já redigido nesta pilha | `Command`, `AggregateCommand` |
| `instanceof DomainEvent` ou forma de `IDomainEvent` | achata (§C3) | eventos de domínio |
| `typeof value.toSafeJSON === "function"` | `toSafeJSON()` | **wrappers** — ver abaixo |
| nenhuma | devolve por identidade | tudo mais |

**O ramo estrutural não é um resquício de duck-typing: é obrigatório.** `arrayOf`/`optionalOf`/`nullableOf`
produzem **classes anônimas criadas em runtime** por `defineWrapper`
(`beans/src/domain/wrapper/helpers/define-wrapper.ts`) — não existe classe exportada contra a qual testar
`instanceof`. O contrato que elas garantem é `toSafeJSON`
(`define-wrapper.ts:211`), e é por ele que se pega. O ramo fica **por último**, depois de todos os `instanceof`,
para que só receba o que as classes nomeadas não capturaram.

O `[Meta]` do `ValueObject` é slot de **instância** (`beans/src/domain/value-object/value-object.ts:52,88`),
lido com o símbolo `Meta` de `@roastery/terroir/symbols` — o mesmo símbolo que o beans escreve, já que o terroir
é a única sede de declaração. O unwrap do VO não-sensível é um ganho colateral: `{ email: emailVO }` vira
`{ email: "a@b.c" }` no log em vez de `{ email: { value: "a@b.c" } }`.

O módulo exporta uma função de conversão de **um valor** e uma que percorre um `Record` de topo devolvendo o
original por identidade quando nada casou — o mesmo padrão de lazy clone de `redactShallow`
(`src/internal/redact.ts:38`), para manter o custo em zero no caminho comum sem domínio.

**Profundidade:** só o nível de topo de `bindings`/`meta` é varrido. Um objeto de domínio aninhado dentro de um
literal (`{ ctx: { user } }`) não é alcançado — a recursão para dentro de objetos de domínio é do próprio
`toSafeJSON`, que já é recursivo. Isso espelha o escopo shallow deliberado do redact e mantém a promessa de
custo constante do pipeline.

### C2. `src/processors/domain.ts` (novo) — `createDomainProcessor()`

Um processor, não um replacer no serializer. O `CLAUDE.md` do projeto é explícito: *"Processors own
cross-cutting concerns, so a transport can never 'forget to redact'"*. Se a conversão vivesse em
`serializeEvent`, o `ConsoleTransport` (que usa `safeStringify`) e o `NullTransport` (que expõe `transport.events`
cru para os testes) continuariam vendo a instância viva com os valores reais.

- Assina `IProcessor` (`src/types/processor.interface.ts`), síncrono, retorna evento novo ou o mesmo por
  identidade. Nunca muta `event.bindings` (é `Object.freeze`d quando não há contexto async ativo).
- Exportado em `src/processors/index.ts` junto dos demais factories.
- **Auto-injetado por `createAroma`**, na mesma linha do redact e **antes** dele:
  ordem final `[domain, redact, ...user]`. Domínio primeiro para que o que ele produz (valores desembrulhados,
  chaves achatadas de evento) ainda passe pelo redact shallow.
- Desligável pelo mesmo interruptor do redact: `redact: false` também dispensa este processor — quem pede
  "sem redação" não quer o custo da varredura. Documentar isso no TSDoc de `CreateAromaArgs.redact`
  (`src/create-aroma.ts:41`).

### C3. Domain events achatados

`instanceof DomainEvent` cobre quem estende a base. Mas `Entity.raiseEvent` aceita **qualquer objeto** com a
forma `{ name, ...payload }` e o buffer guarda objetos planos, nunca instâncias — o próprio TSDoc do beans diz
que `.on()` casa por `name` e nunca por `instanceof`
(`beans/src/domain/domain-event/domain-event.ts`). Então a detecção é `instanceof DomainEvent` **ou** a forma
estrutural: `name`, `occurredAt` e `aggregateId`, as três `string`.

Uma chave `K` cujo valor é um domain event é substituída por chaves de topo prefixadas:

```ts
log.info({ event: orderConfirmed }, "pedido confirmado");
// meta → {
//   "event.name": "order.confirmed",
//   "event.aggregateId": "01J...",
//   "event.occurredAt": "2026-08-25T13:04:11.000Z",
//   "event.payload": { total: 1500 }      // só quando o evento declarou payload
// }
```

`payload` é omitido quando `undefined` (é `declare readonly payload?` na base — um evento construído
genuinamente não o carrega). O `payload` que chega já foi resolvido pelo `raiseEvent` segundo a declaração
`static payload` do evento; se o autor declarou `SafeJson`, ele já vem redigido. O aroma não reinterpreta essa
escolha — mas passa o `payload` pelo conversor de §C1 de qualquer forma, porque um evento construído à mão pode
carregar instâncias vivas.

### C4. O placeholder vem do beans

Em vez de fixar uma constante, o aroma **lê a configuração de redação do beans**:

```ts
import { redactionConfig } from "@roastery/beans";

const { placeholder } = redactionConfig();
```

Uma única chamada a `configureRedaction({ placeholder })`
(`beans/src/shared/redaction/redaction-config.ts:83`) passa a governar os dois pacotes — não há como os dois
divergirem numa mesma linha de log, que é o problema que uma constante alinhada à mão só adiaria.

Consequências:

- `redactShallow` (`src/internal/redact.ts:1`) deixa de ter `REDACTED` como constante de módulo e resolve o
  placeholder por chamada. O default do beans é `"[redacted]"`, então a saída muda de `"[REDACTED]"` para
  `"[redacted]"` quando nada é configurado.
- O aroma passa a suportar **placeholder-função** — `(value, { name, source }) => unknown` — que é como o beans
  permite mascaramento parcial (`a***@b.dev`, últimos quatro dígitos). Onde o aroma redige por nome de chave, o
  `context` é `{ name: <a chave>, source: "@roastery/aroma" }`; onde redige um `ValueObject` sensível, o
  `source` é o `[Source]` do agregado quando disponível.
- A resolução (`typeof placeholder === "function" ? placeholder(...) : placeholder`) é reimplementada em duas
  linhas no aroma: `redactedValue` é interno ao beans e `beans/src/shared/redaction/` não tem `index.ts`, logo
  não há subpath público. O tipo `RedactionPlaceholder` **é** exportado do barrel raiz, então a reimplementação
  é tipada contra o contrato real. *Opcional, se preferir uma sede só:* um `index.ts` de duas linhas em
  `beans/src/shared/redaction/` promoveria `redactedValue` a subpath público e o aroma o importaria.

**Isto muda a saída do logger.** Tratar como breaking:
- atualizar todo spec que asserta a string — 16 ocorrências de `REDACTED` em `src/create-aroma.spec.ts`,
  `src/logger.spec.ts`, `src/processors/redact.spec.ts` e nos dois módulos de redact;
- entrada `### Changed` no `CHANGELOG.md` marcada como BREAKING, avisando que alertas e dashboards que fazem
  match na string precisam ser ajustados;
- `README.md` e o TSDoc de `redactShallow` / `createRedactProcessor` / `DEFAULT_REDACT_KEYS` mencionam o
  sentinel — atualizar.

---

## Parte D — `package.json`, docs e infra

- `dependencies` fica com `@roastery/terroir: ^0.2.2` **e** `@roastery/beans: ^0.6.0` — sem mudança em relação
  ao working tree atual.
- `knip.json` não precisa de entrada nova: o beans passa a ser importado por `src/`, então não é órfão.
- `CLAUDE.md`: apagar a seção **"Current state note"** (a dependência não está mais removida) e registrar na
  seção *Architecture* a nova etapa do pipeline (`domain` antes de `redact`), a posição do aroma na pilha
  (terroir → beans → aroma → barista) e a regra de importar o beans por subpaths estreitos.
- `README.md`: a tabela de dependências (linha 21) ganha a linha do `@roastery/beans`; atualizar o sentinel de
  redação e documentar que `configureRedaction` do beans governa o placeholder do logger.
- `CHANGELOG.md`: nova versão com `### Added` (processor de domínio, `err.code`), `### Changed` (BREAKING do
  placeholder), `### Fixed` (vazamento de campo `sensitive` via `toJSON`).
- **Nota, fora do escopo:** `peerDependencies.typescript` foi fixado em `"7.0.2"`, mas o `tsc` resolvido no
  workspace é 5.9.3. Não bloqueia nada aqui; sinalizar ao final para decisão separada.

---

## Testes

Novos specs colocados ao lado do fonte, com `bun:test`, assertando via `NullTransport` (`transport.events`) —
nunca pelo retorno dos métodos de nível, que são `void`. Com o beans em `dependencies`, as fixtures são
**instâncias reais** (uma `Entity` com um VO `sensitive: true`, um `Command`, um `arrayOf`, um `DomainEvent`),
não dublês — o teste passa a provar o comportamento contra o beans de verdade.

- `src/internal/domain-safe.spec.ts` — cada linha da tabela de §C1, mais: valor sem domínio volta por
  identidade (sem alocação); `null`/primitivo/array não quebram; VO sensível com `redactWith` função recebe
  `(value, { name, source })`; um `arrayOf(PasswordVO)` cai no ramo estrutural e redige.
- `src/processors/domain.spec.ts` — não muta `bindings` congelado; devolve o mesmo evento por identidade quando
  nada casa; roda antes do redact na ordem montada por `createAroma`.
- `src/create-aroma.spec.ts` — `redact: false` não injeta o processor de domínio; ordem `[domain, redact, …user]`.
- `src/internal/serialize-error.spec.ts` — `code` presente para exceção de aplicação, ausente para
  infra/domínio/`UnknownException`.
- `src/internal/redact.spec.ts` — o placeholder acompanha `configureRedaction`, inclusive na forma função;
  restaurar o default com `configureRedaction()` no `afterEach`, já que é estado de módulo no beans.
- **Regressão do vazamento** (o mais importante): uma `Entity` real com propriedade `sensitive: true`, logada
  como `log.info({ user }, "…")`, e a asserção de que a linha serializada **não contém** o valor real.
- **Premissa do desenho:** um spec que assere que `Entity.toJSON()` **não** redige. Todo este trabalho existe
  por causa disso; se um dia o beans mudar, é esse teste que avisa em vez de o código virar morto em silêncio.

## Verificação

```bash
bun install
bunx tsc --noEmit -p tsconfig.json   # deve sair limpo — hoje: 3 erros
bun run test:unit
bun run test:coverage
bun run knip
bun run build                         # biome --fix && knip && tsup
bun run bench:compare                 # o processor de domínio entra no pipeline: confirmar <5% de regressão
```

`bench:compare` é a checagem que importa em §C2: o processor roda em todo evento efetivo. Se a varredura de topo
custar mais que o orçamento, a saída é estreitar a detecção (checar `typeof === "object"` antes de qualquer
`instanceof`), não abrir mão da garantia.

Fim a fim, em um scratch script: montar um logger com `NullTransport`, logar uma entity real com campo sensível
e um domain event, e conferir a linha serializada — o campo redigido e as chaves `event.*` achatadas.
