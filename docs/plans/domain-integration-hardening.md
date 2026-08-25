# Plano 2 — Fechar as lacunas do plano 1 (`docs/plans/terroir-0.2.2-beans-integration.md`)

## Context

Assumindo o plano 1 aplicado: o build compila no terroir 0.2.2, `@roastery/beans` está em `dependencies`,
existe um `createDomainProcessor` auto-injetado que troca objetos de domínio pela forma redigida no **topo** de
`bindings`/`meta`, domain events são achatados e o placeholder vem de `redactionConfig()` do beans.

Restam nove lacunas verificadas no código. **Três ainda são vazamento de campo `sensitive`** — o plano 1 fecha o
caminho comum (`log.info({ user }, "…")`) e deixa abertos três caminhos igualmente comuns. Uma quarta é perda
silenciosa de dados. As demais são integridade de saída, resiliência do acoplamento e rollout.

A ordem abaixo é de prioridade: a Fase 1 é a que não pode ficar pela metade, porque um logger que veda três das
quatro portas não é um logger que veda.

---

## Fase 1 — Vazamentos que o plano 1 não alcança

### 1.1 `err.cause` carregando um objeto de domínio

`serializeCause` devolve qualquer não-`Error` intocado (`src/internal/serialize-error.ts:88`). E `serializeError`
roda dentro de `emit`, **antes** do pipeline de processors (`src/logger.ts:226`) — então o `createDomainProcessor`
nunca vê esse ramo.

```ts
throw new BadRequestException("checkout", "carrinho inválido", { cause: user });
// err.cause → instância viva → JSON.stringify → toJSON() → senha em claro
```

O padrão é encorajado pelo próprio terroir 0.2: o TSDoc de `CoreException` diz para traduzir a falha de baixo
nível passando o original em `cause` (`terroir/src/exceptions/core/core-exception.ts`).

**Correção:** em `serializeCause`, antes do `return cause` final, passar o valor pelo conversor de
`src/internal/domain-safe.ts` (§C1 do plano 1). Ambos vivem em `internal/`, sem ciclo. Aplica-se recursivamente,
já que `serializeCause` se chama a si mesma para o `cause` aninhado.

### 1.2 Objeto de domínio dentro de uma coleção no topo

A varredura do plano 1 olha os **valores** de topo. Um `Array` cru não casa com nenhum `instanceof` do beans nem
tem `toSafeJSON`, então volta por identidade e o `JSON.stringify` chama o `toJSON()` de cada item.

```ts
log.info({ users: [alice, bob] }, "listagem");     // vaza
log.info({ byId: new Map([["a", alice]]) }, "…");  // vaza (e Map serializa como {})
```

Os wrappers do beans (`arrayOf`, `optionalOf`, `nullableOf`) **têm** `toSafeJSON`
(`beans/src/domain/wrapper/helpers/define-wrapper.ts:211`) e já estavam cobertos — o buraco é o array/`Map`/`Set`
JavaScript cru, que é como a maioria dos call sites monta um payload de log.

**Correção:** o conversor passa a descer em `Array` e nos iteráveis nativos (`Map`, `Set`), convertendo item a
item e devolvendo a coleção original por identidade quando nenhum item casou — mantendo o lazy clone de
`redactShallow` (`src/internal/redact.ts:38`). A descida é **só em coleções**, não em objetos planos: aquele é o
item registrado em "Fora de escopo", deliberadamente adiado.

### 1.3 Duplicação de `@roastery/beans` em `node_modules` quebra `instanceof` em silêncio

O plano 1 usa `instanceof Entity` / `ValueObject` / `Command`. Se duas cópias do beans coexistirem no grafo — o
`barista` depende de aroma **e** de beans, e ranges divergentes bastam — uma entity construída pela cópia A não é
`instanceof` da classe da cópia B. A detecção falha, o objeto volta por identidade, e o vazamento retorna **sem
erro de tipo e sem exceção**.

O mesmo vale para o `configureRedaction`, que o beans mantém como estado de módulo e documenta exatamente essa
ressalva: *"a `globalThis` slot would only buy something if the package were ever duplicated inside
`node_modules`"* (`beans/src/shared/redaction/redaction-config.ts`).

**Correção:** o ramo estrutural `toSafeJSON` que o plano 1 já criou para os wrappers vira também a **rede de
segurança** dessa falha — ele fica por último e pega instâncias de outra cópia, que continuam tendo o método
ainda que não o prototype. Para `ValueObject` o equivalente é testar `defineMeta` como função, que é como o
próprio beans faz internamente e por essa mesma razão (`beans/src/shared/helpers/is-value-object.ts`). Somar a
isso um spec que simule a duplicação (uma classe com a forma certa e prototype alheio) e assere que a redação
acontece mesmo assim.

Vale também fixar o range do beans no aroma e no barista para o mesmo valor, e conferir com `bun pm ls` que só
existe uma cópia resolvida.

---

## Fase 2 — Perda silenciosa de dados

### 2.1 Objeto de domínio passado como o próprio `meta`

```ts
log.info(user, "usuário criado");
```

`makeLevelFn` classifica isso como `meta` (`src/logger.ts:198`), e `emit` faz `{ ...meta }`
(`src/logger.ts:225`). O spread copia own-enumerable **incluindo chaves de símbolo**, então `[Context]`,
`[Properties]` e `[Source]` são copiados com os value-objects vivos dentro — mas nenhuma chave string. O
`JSON.stringify` ignora símbolos, e a linha sai `"meta":{}`.

Não é vazamento; é o log inteiro desaparecendo sem erro. E o `createDomainProcessor` não alcança: quando ele
roda, o spread já aconteceu e o que resta não é mais reconhecível como objeto de domínio.

**Correção:** converter **antes** do spread. Em `makeLevelFn`, no ramo `typeof first === "object"`, testar o
objeto pelo conversor de domínio; se casar, o resultado (um objeto plano já redigido) vira o `meta`. O custo
para o caminho comum é um `typeof`/`instanceof` a mais por chamada efetiva — medir na Fase 5.

Cobrir também `log.info(user)` sem mensagem, e `log.error(exception, user)` — onde `first` é `Error` e o
segundo argumento não é string (hoje é descartado; manter o comportamento, apenas documentá-lo).

---

## Fase 3 — Integridade da saída ECS

### 3.1 `err.code` some no ECS

`createEcsProcessor` mapeia só `name`/`message`/`stack` de `err` (`src/processors/ecs-mapping.ts:63`). O `code`
que o plano 1 §B2 passou a emitir é descartado justamente no formato onde ele mais serve.

**Correção:** mapear `err.code` → `error.code` (string, conforme ECS) e, quando a camada é `"application"`,
também `http.response.status_code` (number) — é o campo que dashboards de HTTP realmente consultam. A camada já
está em `err.layer`, então não é preciso adivinhar.

### 3.2 As chaves `event.*` achatadas colidem com o namespace ECS

O processor ECS espalha `meta` na raiz do documento (`src/processors/ecs-mapping.ts:58`). As chaves achatadas do
plano 1 §C3 (`"event.name"`, `"event.aggregateId"`, `"event.occurredAt"`) chegam ali como nomes pontilhados, que
o Elasticsearch expande em um objeto `event` — e `event` é um **namespace reservado do ECS**, com significado
próprio para `event.action`, `event.id` e `event.created`. O resultado é um documento que parece ECS e não é.

**Correção:** o processor ECS reconhece o prefixo achatado e o traduz para os campos ECS corretos:

| aroma (achatado) | ECS |
|---|---|
| `<k>.name` | `event.action` |
| `<k>.aggregateId` | `event.id` |
| `<k>.occurredAt` | `event.created` (ISO 8601 — já é) |
| `<k>.payload` | permanece sob `<k>.payload`, fora do namespace `event` |

Também definir `event.kind: "event"` e `event.dataset` a partir do prefixo, que é o que torna o documento
filtrável no Kibana. Como o ECS deve rodar **por último** (convenção documentada no TSDoc do próprio processor),
ele vê as chaves já achatadas e a tradução é direta.

---

## Fase 4 — Custo e superfície do acoplamento

### 4.1 Carga do beans no caminho do logger

Com o beans em `dependencies`, importar `Entity`/`ValueObject`/`Command` põe typebox e slugify no grafo de carga
de qualquer processo que apenas construa um logger — inclusive um CLI que só loga strings. O plano 1 já manda
importar pelos **subpaths estreitos**, mas `redactionConfig` só existe no barrel raiz
(`beans/src/index.ts:47`), que reexporta `./domain` e `./application` inteiros e anula parte da mitigação.

**Correção, em duas partes:**
- Medir antes de decidir: tempo de `import "@roastery/aroma"` com e sem o beans no grafo, registrado junto do
  bench. Se o custo for irrelevante para os processos reais do ecossistema, nada mais a fazer — e essa é a
  hipótese mais provável, já que os consumidores do aroma já carregam o beans de qualquer forma.
- Se pesar: pedir ao beans um `src/shared/redaction/index.ts` (duas linhas), promovendo `redactionConfig` — e de
  quebra `redactedValue` — a subpath público `@roastery/beans/shared/redaction`. Aí nenhum import do aroma
  precisa tocar o barrel raiz, e a reimplementação de duas linhas do plano 1 §C4 some junto.

### 4.2 O beans é pré-1.0 e quebra por design

O último commit do beans é `feat(domain)!: equality per pillar, deep event drain, adopted instances and event
payloads` — breaking, recente. O aroma passa a depender de contratos internos desse pilar (`toSafeJSON` não
redigir em `toJSON`, `[Meta]` ser slot de instância, `Command.toJSON` redigir). Enquanto o beans não chegar a
1.0, cada minor pode mexer nisso.

**Correção:** os specs de premissa do plano 1 (§Testes) são a rede — mas só se rodarem contra a versão nova. Duas
medidas baratas: fixar o range com til (`~0.6.0`) em vez de caret enquanto o beans for pré-1.0, para que um
minor não entre sozinho; e registrar no `CLAUDE.md` do aroma quais contratos do beans são premissa, com link
para os specs que os travam, para que quem subir a versão saiba o que reler.

---

## Fase 5 — Desempenho, worker e rollout

### 5.1 Bench sem cenário de domínio

`bench/baseline.json` tem quatro cenários, nenhum com objeto de domínio, e o `createDomainProcessor` roda em
**todo** evento efetivo. O `bench:compare` do plano 1 mede o custo da varredura em payloads sem domínio (o
caminho comum, que deve ficar em zero) — e nada mais.

**Correção:** dois cenários novos em `bench/throughput.bench.ts` — "effective + domain hit" (uma entity no meta)
e "effective + domain miss" (payload plano, provando o lazy clone). Regravar `bench/baseline.json` depois que
as Fases 1–4 estabilizarem, e registrar no commit que o baseline foi regravado e por quê — o `compare.ts` falha
acima de 5%, e um baseline movido sem justificativa é como uma regressão entra sem ser vista.

### 5.2 `WorkerTransport` com o processor desligado

`postMessage` faz structured clone, que descarta símbolos e não-enumeráveis — o próprio transport documenta isso
(`src/transports/worker-transport.ts:104`). Com o processor de domínio ativo nada disso importa, porque o evento
já é plano. Mas `redact: false` desliga os dois processors (decisão do plano 1 §C2), e aí uma entity atravessa a
fronteira e chega ao worker como `{}`.

**Correção:** não mudar o comportamento — `redact: false` significa "sem varredura", e mudar isso seria
desrespeitar o pedido. Documentar a consequência no TSDoc de `CreateAromaArgs.redact` e no README: com
`redact: false`, objetos de domínio devem ser serializados pelo call site (`user.toSafeJSON()`) antes de entrar
no log. Adicionar um spec que fixe esse comportamento, para que seja uma escolha registrada e não um bug
esperando ser reportado.

### 5.3 Rollout no ecossistema

`barista` é o único consumidor do aroma no monorepo (`barista/src/index.ts:16`, `packages/env`,
`packages/error-handler`, `packages/request-trace`) e pina `"@roastery/aroma": "^0.0.3"`. Com caret em `0.0.x` o
range é exato, então ele não recebe nada do que foi feito aqui — e a mudança de placeholder do plano 1 §C4 é
breaking para os specs dele.

**Correção (fora deste repo, a rastrear):**
- publicar/`bun link` a nova versão e subir o range no `barista`;
- rodar a suíte do barista contra ela — os asserts de `"[REDACTED]"` quebram por desenho;
- conferir que aroma e barista resolvem **uma única** cópia do beans (ver Fase 1.3);
- e a oportunidade que fecha o círculo: o `MIGRATION.md` do terroir §B1 manda o barista apagar
  `src/packages/error-handler/constants/status-code-map.ts` e ler `error.code`. O aroma agora **emite** esse
  campo (plano 1 §B2), então o error-handler pode ler o status direto da exceção em vez de manter uma tabela
  nome-de-classe→status que quebra a cada classe nova.

---

## Fora de escopo, registrado

**Redação profunda de objetos planos.** `{ req: { headers: { authorization } } }` continua vazando: o redact do
aroma é shallow por decisão de MVP, e o `CLAUDE.md` registra que dot-paths são uma extensão aditiva. Isso é
anterior ao beans e independente dele — a Fase 1.2 desce em coleções justamente porque coleção é transporte de
objeto de domínio, não porque a política shallow tenha mudado. Merece plano próprio, com o custo medido antes.

---

## Verificação

```bash
bun install
bun pm ls | grep beans                # uma única cópia resolvida (Fase 1.3)
bunx tsc --noEmit -p tsconfig.json
bun run test:unit
bun run test:coverage
bun run knip
bun run build
bun run bench:compare                 # cenários de domínio novos; <5% no caminho sem domínio
bun run bench:leak
```

A checagem que decide se este plano cumpriu o objetivo é uma só, e é adversarial: escrever um spec que tenta
vazar um campo `sensitive` pelas quatro portas — dentro de `meta`, dentro de `err.cause`, dentro de um array, e
como o próprio `meta` — e confirmar que nenhuma das quatro linhas serializadas contém o valor real. As Fases 1 e
2 existem para esse teste passar. Repetir a quarta porta com uma instância de prototype alheio é o que prova a
Fase 1.3.
