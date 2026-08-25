# Plano 3 — Garantias do pipeline

Fecha as brechas **pré-existentes** que os planos 1 e 2 não tocam, e as que os próprios planos 1 e 2 **abrem**.

- Plano 1: `docs/plans/terroir-0.2.2-beans-integration.md`
- Plano 2: `docs/plans/domain-integration-hardening.md`

## Context

Os planos 1 e 2 tratam do **conteúdo** do log: que um objeto de domínio não vaze um campo `sensitive` por
nenhuma das portas. Este plano trata do **pipeline** que carrega esse conteúdo — e ele nunca teve as garantias
que os transports têm.

Isso não importava enquanto todos os processors eram código nosso, síncrono e trivial. Os planos 1 e 2 mudam
essa premissa em três frentes de uma vez:

- passam a executar **código do beans** (`toSafeJSON`, recursivo, com getters de value-object no caminho) dentro
  do pipeline;
- passam a executar **código arbitrário do consumidor** (o placeholder-função que chega por
  `configureRedaction`) dentro do pipeline;
- passam a fazer trabalho **caro** por evento, onde antes o processor mais pesado era um `Object.assign`.

Somam-se a isso duas brechas anteriores ao beans e independentes dele: a redação continua sendo shallow (um
`authorization` dentro de `req.headers` vaza hoje, e continuaria vazando depois dos dois planos) e a API tipada
discorda do runtime sobre o que é um argumento válido.

O princípio que organiza tudo abaixo já está escrito no `CLAUDE.md` do projeto, só que aplicado a metade do
pipeline: *"Transports never throw at the caller. One failing transport must never block peers or the caller."*
Um processor pode.

---

## Fase 1 — Um processor não pode derrubar quem chamou o log

**Brecha aberta pelos planos 1 e 2. É a mais grave deste plano.**

`Logger.emit` roda o pipeline sem qualquer proteção (`src/logger.ts:229`):

```ts
for (const processor of this.processors) {
  event = processor.process(event);
  if (event === null) return;
}
```

`handleTransportError` (`src/logger.ts:256`) existe só para o laço de transports. Depois do plano 1, esse laço
desprotegido executa `entity.toSafeJSON()` e um placeholder-função escrito pelo consumidor. O resultado é que
`log.info({ user }, "…")` passa a poder lançar no call site — um logger derrubando a aplicação que ele deveria
apenas observar.

### 1.1 `ProcessorFailureException`

Nova classe em `src/exceptions/aroma-exception.ts`, ao lado de `BackpressureDropException`, estendendo
`AromaException` (portanto `InfraException` → `CoreException`):

```ts
export class ProcessorFailureException extends AromaException {
	public override readonly name = "Processor Failure Exception";
	public readonly processorName: string;
}
```

O `cause` carrega o valor lançado, e `processorName` vem de `IProcessor.name` (`"<unnamed>"` quando ausente,
espelhando o que `handleTransportError` já faz com transports). Exportar no barrel `src/exceptions/index.ts`.

### 1.2 A política de falha: descartar o evento

```ts
for (const processor of this.processors) {
	try {
		event = processor.process(event);
	} catch (processorError) {
		this.handleProcessorError(processor, processorError);
		return;                      // descarta o evento
	}
	if (event === null) return;
}
```

**Descartar é a única opção segura, e a razão é específica deste pipeline.** Quando um processor lança no meio
da execução, o evento fica em estado indeterminado: pode estar parcialmente convertido, ou ainda ser o original
com a instância viva dentro. Seguir adiante com ele significa entregar aos transports exatamente o objeto que o
processor de redação não terminou de redigir — ou seja, a falha de um processor de segurança viraria o vazamento
que ele existe para impedir. Perder uma linha de log é estritamente melhor.

Para que a perda nunca seja silenciosa, duas saídas:

- `onError` recebe a `ProcessorFailureException`, como já acontece com falhas de transport;
- uma **linha de diagnóstico** é escrita direto nos transports, com `level: "error"`, contendo o nome do
  processor e a mensagem do erro — e **nenhum resto do payload original**, já que é justamente o payload que não
  se sabe se está seguro. Ela vai direto aos transports, sem reentrar no pipeline, para não arriscar o mesmo
  processor derrubá-la de novo.

Documentar a garantia nova no TSDoc de `IProcessor` (`src/types/processor.interface.ts`) e na seção
*Architecture* do `CLAUDE.md`, ao lado da frase equivalente sobre transports.

### 1.3 Cobertura de teste

- um processor que lança em cada posição do pipeline (primeiro, meio, último) — o call site nunca vê a exceção;
- `onError` recebe uma `ProcessorFailureException` com `processorName` e `cause` corretos;
- o evento é descartado e a linha de diagnóstico chega ao `NullTransport` sem nenhum campo do payload original;
- `onError` ausente não quebra nada (o `handleTransportError` já trata isso — espelhar);
- um `onError` que **ele mesmo** lança não escapa (`handleTransportError` já envolve a chamada em `try`;
  confirmar que o caminho novo faz o mesmo).

---

## Fase 2 — Fazer a API tipada e o runtime concordarem

**Brecha aberta pelo plano 2 §2.1, que caracterizou como problema de runtime algo que é, antes, de tipos.**

A Fase 2 do plano 2 manda consertar `makeLevelFn` para tratar um objeto de domínio passado como o próprio
`meta`. Mas isso hoje **não compila**:

```
error TS2345: Argument of type 'UserEntity' is not assignable to parameter of type 'Bindings'.
  Index signature for type 'string' is missing in type 'UserEntity'.
```

`Bindings = Record<string, unknown>` (`src/types/bindings.ts:21`) e classes não recebem index signature
implícita — object literals recebem, e é por isso que `log.info({ user }, "…")` passa e `log.info(user, "…")`
não. Consertar só o runtime resolve a metade que o TypeScript já bloqueia.

### 2.1 Overload de objeto de domínio em `ILogger`

Cada nível ganha uma sobrecarga, ao lado das três que já existem
(`src/types/logger.interface.ts:47-49`):

```ts
info(msg: string): void;
info(err: Error, msg?: string): void;
info(domain: IDomainLoggable, msg?: string): void;   // nova
info<TMeta extends Bindings>(meta: TMeta, msg?: string): void;
```

`IDomainLoggable` é um tipo novo em `src/types/` descrevendo o que o conversor sabe converter — na prática
`{ toSafeJSON(): object }` mais a forma de `IDomainEvent`. A sobrecarga entra **antes** da de `Bindings`, porque
a resolução é por ordem e a de `Bindings` é a mais larga.

Isto é coerente com a razão de o beans estar em `dependencies`: se o framework existe para que as bibliotecas se
conheçam, `log.info(user, "usuário criado")` é a forma que o consumidor espera escrever, e o tipo deve aceitá-la.

### 2.2 O runtime é defensivo de qualquer forma

A correção de `makeLevelFn` descrita no plano 2 §2.1 continua valendo mesmo com o overload — JS puro, um `as
any`, ou um valor vindo de `JSON.parse` chegam sem passar pelo compilador. Tipos guiam; runtime garante.

### 2.3 Cobertura de teste

Além dos specs de runtime que o plano 2 já prevê, um spec de **tipos**: um arquivo que exercite as quatro
sobrecargas e falhe o `tsc` se alguma parar de resolver. Sem ele, uma sobrecarga na ordem errada degrada em
silêncio para `any` e ninguém percebe.

---

## Fase 3 — Não pagar por um evento que ninguém vai receber

**Brecha pré-existente, agravada pelos planos.**

O gate por-transport roda **depois** do pipeline (`src/logger.ts:234-241`): os processors já executaram quando
se descobre que nenhum transport aceita aquele nível. Com processors baratos isso era irrelevante. Com
`toSafeJSON` recursivo sobre um agregado, um `log.debug({ aggregate }, …)` numa aplicação cujos transports estão
todos em `error` paga a conversão inteira e joga fora.

Note que o gate do **logger** já é resolvido na construção, de forma exemplar: níveis abaixo do limiar são
ligados a `NOOP_VOID` e não constroem evento nenhum (`src/logger.ts:129-131`). O que falta é o mesmo raciocínio
para o limiar efetivo dos transports.

### 3.1 Limiar mínimo pré-computado

No construtor do `Logger`, computar `minTransportLevel` = o menor `LEVEL_NUMERIC` entre os transports
(transports sem `level` próprio contam como "aceita tudo", e nesse caso não há saída antecipada). Em `emit`,
antes do laço de processors:

```ts
if (levelValue < this.minTransportLevel) return;
```

**Contrapartida a documentar:** isso fixa como contrato que um processor não pode *elevar* o nível de um evento
para além do gate. Nenhum processor embutido faz isso — `filter` e `sample` só descartam, `enrich` e `otel` só
acrescentam bindings, `ecs` só remapeia — mas hoje nada proíbe, e depois disto passa a proibir. Registrar no
TSDoc de `IProcessor` e no `CLAUDE.md`.

O evento continua sendo construído (é barato e `Date.now()` já foi chamado); o que se evita é o pipeline. Se o
bench mostrar que vale, um segundo passo é adiar a própria construção — mas isso mexe no caminho quente e só se
justifica com número na mão.

---

## Fase 4 — Redação profunda

**Brecha pré-existente, e a maior das que sobram.** O plano 2 a registrou em "Fora de escopo" e mandou fazer um
plano próprio; este é ele.

`redactShallow` só inspeciona o nível de topo (`src/internal/redact.ts:38`), o que o TSDoc do módulo assume
explicitamente como escopo de MVP. Consequência, hoje e também depois dos planos 1 e 2:

```ts
log.info({ req: { headers: { authorization: "Bearer …" } } }, "requisição");
// authorization sai em claro — não é chave de topo, e não é objeto de domínio
```

Este é o caso mais comum de todos em um servidor HTTP, e nada nos dois primeiros planos o alcança: o processor
de domínio só reage a objetos do beans, e um `req` do Node não é um.

### 4.1 `redactDeep` substitui `redactShallow`

Travessia recursiva de `bindings` e `meta` aplicando o mesmo conjunto de chaves em **qualquer** profundidade,
com três proteções que a versão shallow não precisava ter:

- **`WeakSet` de visitados** contra ciclos — `{ a: { self: a } }` não pode virar recursão infinita. O
  `safeStringify` já resolve isso na serialização (`src/internal/safe-stringify.ts:28`), mas ele roda tarde
  demais para este passo.
- **Limite de profundidade** (`maxDepth`, default a definir com o bench na mão — 6 é o palpite inicial), para
  que um payload patologicamente aninhado não vire custo ilimitado no caminho quente.
- **Lazy clone preservado em cada nível**: um subobjeto sem nenhuma chave sensível volta por identidade, e só o
  caminho até uma chave que casou é reconstruído. É o que mantém o custo perto de zero no caso comum, e é a
  propriedade que o `redactShallow` já tem e não pode ser perdida.

Objetos de domínio **não** são atravessados por aqui: eles já foram convertidos pelo processor de domínio, que
roda antes (plano 1 §C2), e sua redação interna é do beans. `redactDeep` desce só em objetos planos, arrays e
nos iteráveis nativos que o plano 2 §1.2 já ensinou o conversor a tratar.

### 4.2 `err` e `err.cause` também passam a ser redigidos

Nem `src/processors/redact.ts` nem `src/internal/redact.ts` mencionam `err` — o objeto de erro nunca é
inspecionado. O plano 2 §1.1 conserta o caso de `err.cause` ser um **objeto de domínio**, mas não o caso de ser
um objeto plano:

```ts
throw new BadRequestException("auth", "falhou", { cause: { password: "hunter2" } });
// err.cause.password sai em claro
```

O redact processor passa a aplicar `redactDeep` também sobre `event.err`, preservando os campos canônicos
(`name`, `message`, `stack`, `source`, `layer`, `code`) e descendo em `cause`.

### 4.3 Isto muda o comportamento, e mais do que a mudança de placeholder

Mais campos passam a ser redigidos do que antes — inclusive campos que consumidores hoje veem em claro e podem
depender de ver. Tratar como breaking, com entrada própria no `CHANGELOG.md`, separada da mudança de placeholder
do plano 1 §C4, e uma nota no README explicando que a redação deixou de ser shallow.

Uma válvula de escape vale a pena: `redact: { keys, maxDepth: 1 }` restaura exatamente o comportamento shallow
para quem precisar dele.

### 4.4 Cobertura de teste e bench

- chave sensível em cada profundidade de 1 a `maxDepth`, e uma além do limite (não redigida, por desenho);
- ciclo direto e indireto não estouram a pilha;
- objeto sem nenhuma chave sensível volta por identidade em todos os níveis (o teste que prova o lazy clone);
- `err.cause` plano com chave sensível é redigido; os campos canônicos de `err` sobrevivem;
- um objeto de domínio já convertido não é atravessado de novo.

Bench: cenário novo com payload aninhado profundo, com e sem acerto. É a mudança deste plano com maior potencial
de custo no caminho quente, e a única cujo default (`maxDepth`) deve sair de uma medição e não de um palpite.

---

## Fase 5 — Higiene de teste

**Brecha aberta pelo plano 1 §C4.**

`configureRedaction` é estado de módulo no beans (`beans/src/shared/redaction/redaction-config.ts`), e o
`bunfig.toml` do aroma roda os testes em série (`serial = true`). Um spec que altere o placeholder e esqueça de
restaurá-lo contamina todos os seguintes — e a falha aparece longe da causa.

O `afterEach` que o plano 1 previu resolve por spec, mas depende de ninguém esquecer. O repositório já tem o
mecanismo certo: `bunfig.toml` pré-carrega `test/set-max-listeners-to-zero.ts` e `test/replace-node-env.ts`.
Somar um `test/reset-beans-redaction.ts` que restaure o default no início de cada arquivo de teste, e manter o
`afterEach` só nos specs que deliberadamente mexem na configuração.

---

## Ordem de execução sugerida

1. **Fase 1** — antes de qualquer coisa dos planos 1 e 2 chegar a produção. É a garantia que os planos assumem
   sem ter.
2. **Fase 3** e **Fase 5** — baratas, independentes, sem risco de comportamento observável (a Fase 3 só evita
   trabalho; a Fase 5 só isola testes).
3. **Fase 2** — depois de o plano 2 §2.1 existir, já que as duas metades (tipos e runtime) devem entrar juntas.
4. **Fase 4** — por último, e sozinha no seu commit: é a de maior superfície de comportamento e a única cujo
   default depende do bench.

## Verificação

```bash
bunx tsc --noEmit -p tsconfig.json
bun run test:unit
bun run test:coverage
bun run knip
bun run build
bun run bench:compare      # Fase 3 deve *melhorar* o cenário abaixo do limiar; Fase 4 é a que arrisca regredir
bun run bench:leak         # a Fase 4 introduz um WeakSet por chamada — confirmar que não retém
```

A checagem que resume este plano é adversarial, como a dos anteriores, mas contra o pipeline em vez do conteúdo:
um processor que lança, um payload com `authorization` a quatro níveis de profundidade, um `err.cause` plano com
`password`, um ciclo, e um `log.debug` numa configuração em que nenhum transport aceita `debug`. Nenhum dos
cinco pode derrubar o processo, vazar um valor, travar, ou custar trabalho que ninguém pediu.
