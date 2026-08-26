# Plano 4 — A travessia alcança instância de classe, e as cinco falhas menores

Fecha os achados da sondagem feita **depois** de a 0.5.0 ficar pronta — incluindo o que restou aberto do
plano 2: a mesma classe de vazamento, entrando por outra fresta.

- Plano 1: `docs/plans/terroir-0.2.2-beans-integration.md`
- Plano 2: `docs/plans/domain-integration-hardening.md`
- Plano 3: `docs/plans/pipeline-guarantees.md`

## Context

A 0.5.0 está pronta na árvore de trabalho — travessia única (`src/internal/safe-walk.ts`), conversão de
domínio profunda, máscara por nome de chave virada opt-in, 312 testes, cobertura 99,89%, bench sem regressão —
e **ainda não foi commitada nem publicada**. Depois de terminá-la sondei o código novo procurando defeito em
vez de confirmação. Sete achados sobreviveram, seis com correção. Como nada saiu ainda, tudo isto entra **na
própria 0.5.0**: publicar uma release com um vazamento conhecido e emendar numa 0.5.1 é pior para quem
atualiza, e o bloco do CHANGELOG já existe para absorver.

| # | Achado | Estado |
|---|---|---|
| 1 | Entidade dentro de instância de classe comum vaza (**porta 6**) | reproduzido |
| 2 | O rebaixamento da redação não tem erro de compilação para quem nunca passou `redact` | por construção |
| 3 | A largura do payload não tem teto — ~9 ns/nó, linear, 19 µs em 200 linhas | medido |
| 4 | Getter que lança em profundidade descarta a linha inteira | reproduzido |
| 5 | O freio de taxa esconde um segundo motivo de falha dentro da janela | reproduzido |
| 6 | O diagnóstico dispara os efeitos colaterais dos processors seguintes | reproduzido |
| 7 | `Map`→objeto, `Set`→array | decisão deliberada, documentada — **sem ação** |
| 8 | `toJSON()` alcança estado que a travessia não vê (**porta 7**) | reproduzido — Fase 7 |

### O achado que importa

O plano 2 catalogou quatro portas por onde um campo `sensitive` sai de um objeto de domínio, e a 0.5.0
acrescentou a quinta (abaixo de um literal simples). Existe uma sexta:

```ts
class Wrapper { constructor(u) { this.user = u; } }
log.info({ ctx: new Wrapper(user) }, "…");
// → "password":"Sup3rS3cret!"
```

`descendable()` (`src/internal/safe-walk.ts:164`) recusa instância de classe. Isso é o que impede a travessia
de vasculhar um `Date`, um `Error` ou um handle de banco — mas recusa também uma classe que apenas *carregue*
uma entidade, e aí `JSON.stringify` serializa as próprias propriedades enumeráveis dela e chega no `toJSON()`
sem redação, que é o contrato de persistência do beans.

Não é regressão: vazava igual na 0.4.0, e a 0.5.0 apenas estreitou a fresta ao fechar o caminho por literal.
Mas não está fixado por spec nenhuma, e DTO, wrapper de resposta e objeto de resultado de serviço têm todos
essa forma.

### O que a sondagem de runtime mudou no custo da correção

A premissa era que descer em instância de classe fosse caro e perigoso — getters preguiçosos, proxies,
grafos de ORM. Medido, quase nada disso se sustenta:

| valor | `Object.keys()` | consequência |
|---|---|---|
| `class Wrapper { constructor(u){this.user=u} get lazy(){throw} }` | `["user"]` | **getter de protótipo não é invocado** |
| `Date`, `Error`, `Promise`, `URL`, `RegExp`, `ArrayBuffer` | `0` | vira no-op sozinho, volta por identidade |
| `Uint8Array(1000)`, `Buffer.alloc(1000)` | `1000` | **o único perigo real** |

`Object.keys` devolve só propriedade **própria enumerável**, e getter declarado numa classe mora no protótipo.
O risco que parecia justificar a recusa quase não existe; o que precisa de guarda explícita é binário.

---

## Fase 1 — Um getter hostil não pode derrubar a linha

**Achado 4. Vem primeiro de propósito:** a Fase 2 alarga o alcance da travessia e com isso a chance de
encontrar um getter próprio que lança ou um `Proxy` com trap hostil. A resiliência precisa já estar no lugar.

Hoje um getter que lança em nível 3 faz o processor de domínio falhar, e `Logger.emit` descarta o evento
inteiro — comportamento correto para *um processor qualquer*, porque um processor que falhou no meio deixa o
evento indeterminado (plano 3, fase 1). Mas os processors embutidos podem fazer melhor que isso: eles sabem
exatamente qual metade falhou.

**Muda:** `src/processors/domain.ts:60`, `src/processors/redact.ts:108`

- Envolver as duas conversões (`bindings` e `meta`) em `try`/`catch` **separadamente**, para que uma falha em
  `meta` não leve `bindings` junto.
- No `catch`, substituir **só o registro que falhou** por `{ "$aroma.error": "conversion failed: <mensagem>" }`.
  A linha sobrevive e nada do payload meio-convertido é encaminhado — que é a razão original do descarte.
- Mesmo tratamento no `createRedactProcessor`: um getter hostil quebra os dois igual.
- O contrato do `IProcessor` **não muda** ("um processor que lança tem o evento descartado"); o que muda é que
  os processors embutidos deixam de lançar. Ajustar o TSDoc dos dois para dizer isso.

**Custo a confirmar, não presumir:** dois `try`/`catch` por evento no caminho quente. O V8 e o JSC não cobram
por `try` que não dispara, mas isso é premissa — medir em `aroma-meta` e `deep-miss` antes de seguir.

---

## Fase 2 — A travessia alcança instância de classe

**Achado 1.** `src/internal/safe-walk.ts:164`

```ts
function descendable(value: unknown): value is Descendable {
	if (typeof value !== "object" || value === null) return false;
	if (Array.isArray(value) || value instanceof Map || value instanceof Set) return true;
	// Binário nunca: Object.keys(new Uint8Array(1000)) devolve 1000 índices,
	// e não há objeto de domínio escondido dentro de um buffer.
	if (ArrayBuffer.isView(value)) return false;
	return true;
}
```

O que isso implica:

- `{ ctx: new Wrapper(user) }` **e** `{ ctx: new Wrapper({ user }) }` passam a converter — a porta fecha nos
  dois níveis, porque os valores da instância vão para a mesma máquina de travessia.
- `Date` / `Error` / `Promise` / `URL` / `RegExp` continuam voltando **por identidade**, e não por regra
  especial: não têm propriedade própria enumerável, e o clone preguiçoso faz o resto. Uma regra a menos.
- Getter de protótipo continua não sendo invocado. Getter **próprio** enumerável passa a ser — coberto pela
  Fase 1.
- `visitDomain` não muda. Seu `return PASS` final já significava "não é meu"; agora quer dizer "desça" em vez
  de "deixe quieto".

**Efeito colateral bom, para o CHANGELOG.** O `createRedactProcessor` usa a mesma `descendable`, então a
máscara por nome de chave passa a alcançar instância de classe — e o `IncomingMessage` do Node é uma. O caso
que motivou a redação profunda na 0.4.0 passa a funcionar também quando se loga o `req` direto, não só o
literal `{ req: { headers: {...} } }`.

**Efeito colateral que a Fase 7 depois corrige.** Quando algo de domínio é achado dentro, a instância vira
objeto simples e um `toJSON()` próprio que ela tivesse deixaria de ser usado. Isso valeu até a Fase 7, que
passou a seguir a projeção — e foi ao investigar essa ponta solta que a porta 7 apareceu.

---

## Fase 3 — Teto de nós

**Achado 3.** `MAX_WALK_DEPTH` limita profundidade e nada limita largura — e a Fase 2 alarga o alcance, então
o teto deixa de ser luxo. Medido: ~9 ns por nó, linear, 19 µs numa lista de 200 linhas contra 102 ns de um
`Logger` sem processors.

**Muda:** `src/internal/safe-walk.ts`

- Trocar o `seen: WeakSet | undefined` que já é passado pela recursão por um
  `WalkState { seen?: WeakSet; left: number }`, **alocado na primeira descida real**, exatamente como o
  `WeakSet` é hoje. Um payload plano continua não alocando nada.
- `maxNodes` entra no `WalkPlan`, ao lado de `maxDepth`. Proposta: **10.000** — cerca de 90 µs pela medição,
  muito além de qualquer payload são (200 linhas × 11 campos = 2.201 nós), de modo que só estrutura
  desgovernada encosta nele. Confirmar contra `deep-literals` antes de fixar.
- Estourado o orçamento, o valor vira `"[truncated: node budget]"`. **Truncar, nunca devolver o valor não
  convertido** — devolver reabriria o buraco pela porta dos fundos, que é precisamente o erro que o plano 3
  corrigiu no tratamento de ciclo.
- Caso de bench em 200 linhas, para o custo de largura ficar visível no gate em vez de na produção de alguém.

---

## Fase 4 — O rebaixamento da redação deixa de ser silencioso

**Achado 2.** Remover a opção `redact` garante erro de compilação para quem a **configurou**, e não cobre
quem nunca a passou — que é a maioria, e exatamente quem dependia do default. Para esses, atualizar de 0.4.x
troca `{ password: "[redacted]" }` por `{ password: "hunter2" }` sem sinal nenhum: compila, os testes passam,
o log muda.

**Muda:** `src/create-aroma.ts`, `src/processors/redact.ts:108`

- `createRedactProcessor` marca o processor que devolve com um símbolo interno (`MASKS_KEYS`), para a detecção
  não depender de comparar `p.name === "redact"`.
- `createAroma` verifica na construção se o pipeline final tem algum processor com essa marca. Não tendo,
  emite **uma vez por processo** um `console.warn` dizendo o que está e o que não está protegido, com a linha
  de opt-in.
- `acknowledgeNoMasking?: boolean` em `CreateAromaArgs` silencia. Quem escolheu isso de propósito declara uma
  vez e nunca mais vê.
- Contador do "uma vez" em escopo de módulo. A suíte roda serial num processo (`bunfig.toml`), então o aviso
  aparece uma vez no output dos testes — aceitável; se incomodar, os specs passam a flag.

---

## Fase 5 — Freio de taxa por motivo, não só por processor

**Achado 5.** `src/logger.ts:415`. A janela é por processor, então um segundo motivo de falha dentro do mesmo
segundo some, contado apenas como `suppressed`.

- `WeakMap<IProcessor, Map<string, FailureWindow>>` — janela por `(processor, mensagem)`.
- Teto de motivos distintos rastreados por processor (**8**), com os excedentes num balde compartilhado. Sem
  isso, um processor cuja mensagem carrega um id (`"falhou para o pedido 91823"`) faz o `Map` crescer sem
  limite — trocar uma enxurrada de log por um vazamento de memória não é correção.
- `onError` continua disparando em toda falha, com o erro original. É o hook do consumidor, não o stream.

---

## Fase 6 — Marcar a linha de diagnóstico

**Achado 6.** `src/logger.ts:463`. Reprocessar o diagnóstico pelo pipeline sem o culpado é o que mantém o
formato ECS (plano 3), e faz os processors seguintes rodarem sobre ele — um contador de métrica passa a contar
a própria linha de diagnóstico.

- Marcar o evento de diagnóstico com um símbolo, no mesmo padrão de `src/internal/formatted.ts`
  (`Object.defineProperty`, não enumerável, invisível a `JSON.stringify` e a `for…in`).
- Exportar `isDiagnostic(event)` pela raiz, junto de `createAroma` e `Logger`, para um processor com efeito
  colateral poder se excluir em uma linha.
- **Não** mudar o comportamento padrão: reprocessar continua certo para formatação. O que falta hoje é a
  *possibilidade* de se excluir, não a exclusão automática.

---

## Fase 7 — A travessia segue o `toJSON()`

**Achado 8, encontrado sondando o código já corrigido.** As seis fases acima fecharam a porta 6, e
uma sétima apareceu — da mesma família, por outra raiz.

O vazamento acontece quando o `toJSON()` de um objeto alcança estado que a travessia **não enxerga**:

```
VAZA    toJSON() + campo privado (#u)
VAZA    toJSON() + privado + prop pública
VAZA    toJSON() + prop não-enumerável
seguro  toJSON() sobre prop enumerável (a travessia enxerga e converte)
```

A raiz é um desencontro de contrato: **a travessia decide o que converter lendo propriedades próprias
enumeráveis; o `JSON.stringify` decide o que emitir chamando `toJSON()`.** Enquanto os dois
concordam, converter as propriedades basta — é por isso que um literal simples segurando uma entidade
sempre foi seguro. Quando discordam, a conversão é contornada inteira.

O mesmo desencontro tinha um segundo efeito que ninguém havia notado: ao clonar, a travessia produz
um objeto simples **sem** o `toJSON()`, então a forma que ele daria ao dado se perdia. Um DTO que
renomeia campos saía renomeado quando nada foi convertido e cru quando alguma coisa foi — o resultado
dependia de o payload ter ou não um objeto de domínio dentro.

**Muda:** `src/internal/safe-walk.ts`, no ramo de `descend()` que caía direto em `record()`.

- `hasOwnProjection` — carga de propriedade primeiro, `getPrototypeOf` depois. Literal simples, que
  domina qualquer payload real, erra na primeira linha e nunca paga a segunda. Literal fica de fora
  de propósito: suas propriedades são visíveis à travessia, então o que a projeção alcança já foi
  convertido no lugar.
- `project` — chama `toJSON()`, roda o visitor sobre o resultado (a projeção pode **ser** um objeto de
  domínio: `toJSON(){ return this.#user }`) e desce. Se nada mudou, **devolve o original por
  identidade**: é isso que impede a correção de virar "substitua todo objeto pelo seu `toJSON()`" —
  um `Date` projeta para string, nada ali é nosso, e o `Date` volta intacto.
- `depth + 1` — a projeção é conteúdo de dentro do objeto, e gastar um nível também limita
  `class A { toJSON(){ return new A(); } }` em `MAX_WALK_DEPTH` em vez de deixá-lo consumir o
  orçamento de nós inteiro.
- `ArrayBuffer.isView` já barrou binário antes daqui, e não é detalhe: `Buffer.alloc(n).toJSON()`
  devolve um elemento por byte.

**Custo medido:** nenhuma regressão. `wide-rows` (~1.400 nós, quase todos literais que erram a carga)
saiu −1,2%; `deep-literals` −1,9%. Caso novo `class-rows` para o ramo que passa a pagar.

---

## Specs

Escrever as da porta 6 **antes** da Fase 2 e vê-las vermelhas — como foi feito com as três da 0.5.0. Uma spec
de vazamento que nunca falhou não prova nada.

**Novas.** Em `src/processors/domain.spec.ts`, o bloco de portas vira **seis**:

- `{ ctx: new Wrapper(user) }` e `{ ctx: new Wrapper({ user }) }` não vazam;
- um `Uint8Array` e um `Buffer` em `meta` voltam por identidade e não são percorridos — a exclusão de binário
  é a única regra especial que sobra na `descendable` e precisa de pino;
- um getter **próprio** que lança em nível 3 preserva a linha, marca o registro e não vaza (Fase 1);
- o teto de nós trunca com marcador visível e não devolve valor não convertido (Fase 3);
- dois motivos diferentes no mesmo segundo produzem duas linhas (Fase 5);
- `isDiagnostic` é verdadeiro na linha de diagnóstico e falso numa linha comum (Fase 6);
- as três formas da porta 7 (privado, privado + público, não-enumerável) não vazam, e uma quarta em
  que o `toJSON()` devolve a entidade direto (Fase 7);
- um `Date` volta **por identidade** e serializa como o ISO de sempre — o pino de que seguir o
  `toJSON()` não virou substituir por ele;
- `class A { toJSON(){ return new A(); } }` termina;
- um `toJSON()` que reformata passa a valer mesmo quando algo foi convertido ao lado — mudança de
  comportamento, e uma correção;
- `createAroma` sem máscara avisa uma vez, e não avisa com `acknowledgeNoMasking` nem com um
  `createRedactProcessor` no pipeline (Fase 4).

**Que quebram:**

| Arquivo | O que quebra |
|---|---|
| `src/internal/redact.spec.ts:230` | *"does not descend into a class instance"* — passa a descer, e um `password` numa instância de classe passa a ser mascarado. A spec **inverte**: ela fixava uma limitação como se fosse contrato. |
| `src/internal/redact.spec.ts:244` | *"does not descend into a Date"* — **sobrevive**, por outro motivo (zero propriedades próprias, não recusa de protótipo). Reescrever o comentário, senão ele passa a mentir. |
| `src/internal/domain-safe.spec.ts:429` | *"a Date and a foreign class instance pass through by identity"* — **sobrevive** pelo clone preguiçoso. Reforçar a asserção para dizer que a identidade se mantém *apesar* de a travessia agora olhar dentro. |

---

## Verificação

1. As specs da porta 6 escritas primeiro e vistas **vermelhas** contra o código atual.
2. Sonda manual das dez cargas da tabela de comparação: as três de domínio e as duas novas de wrapper ficam
   seguras; as quatro de borda continuam dependendo do opt-in.
3. `bun test` — 312 testes hoje; nenhum fica para trás sem justificativa escrita no diff.
4. `bun test --coverage` — 99,89% de linhas é a base; o código novo entra coberto.
5. `bunx tsc --noEmit` e `bun run knip`, **conferindo o exit code**, não só a saída.
6. `bun run bench` contra a baseline atual **antes** de qualquer `--update`. Dois riscos concretos a medir e
   não supor: os `try`/`catch` da Fase 1 em `aroma-meta`/`deep-miss`, e o `WalkState` da Fase 3, que troca uma
   alocação preguiçosa por outra um pouco maior.
7. `bun run bench:leak` — o `WalkState` é novo por travessia; confirmar que não retém.
8. `bun run build`.

## Fechamento

- Absorver tudo no bloco `0.5.0` do `CHANGELOG.md`: a porta 6 em **Fixed**, o aviso e o `acknowledgeNoMasking`
  em **Added**, o alcance novo da máscara em instância de classe em **Changed**.
- `CLAUDE.md`: a regra de descida deixa de ser "protótipo `Object.prototype`" e passa a ser "tudo menos
  binário". A frase atual sobre instância de classe vira mentira — e é exatamente o tipo de frase
  desatualizada que causou o bug original.
- `README.md`: a nota de upgrade ganha o aviso de runtime.
- Fatiar os commits por fase, e terminar a renomeação do husky (`x.husky/` deletado sem commit, `.husky/` sem
  rastreio) **antes** de tudo — enquanto isso não fechar, o commitlint segue desligado.

## Fases 8–12 — a quinta rodada, e a última que precisou ser manual

Depois da Fase 7 sondei de novo, desta vez de forma **combinatória** em vez de por intuição: 18 formas de
embrulho × 4 posições de payload. O resultado dobrou a lista de achados e mostrou que a porta 8, registrada
como limite conhecido e exótico, não era nem uma coisa nem outra.

```
72 combinações → 4 vazamentos, todos a mesma forma em posições diferentes
profundidade  0..5 seguro   6..10 VAZA      ← achado novo, e o mais fácil de acionar de todos
```

### Fase 8 — a projeção vale em qualquer objeto, e também na raiz do registro

`hasOwnProjection` excluía literal simples por um teste de protótipo, defendido por um custo que **não
existia**: a carga de propriedade acontece para todo objeto de qualquer jeito, e era o `getPrototypeOf` — que
só roda quando o `toJSON` existe — que fazia a exclusão. Removê-lo deixou a função mais barata (`deep-literals`
−4,8%, `class-rows` −2,8%) e a regra passou a ser exatamente a do `JSON.stringify`: um `toJSON` chamável,
próprio ou herdado, decide o que o valor é. Virou `hasProjection`.

Isso fecha `meta.k` e `err.cause`. As outras duas posições — `meta` como raiz e `bindings` de um `child` — são
alcançadas **por nome** e nunca passavam por `descend`, então `walkRecord` também projeta agora. Quando a
projeção não é um registro (`{ toJSON: () => [entidade] }`), o valor convertido vai para `"$aroma.value"`:
devolver o original ali seria o vazamento de volta.

### Fase 9 — o guarda de profundidade trunca em vez de deixar passar

`if (depth > plan.maxDepth || !descendable(value)) return value` devolvia o valor **intacto**, que é
literalmente a única coisa que o comentário do teto de nós diz que um guarda nunca pode fazer. A ordem
inverteu: binário e primitivo voltam por identidade, e só o que a travessia *entraria* vira
`"[truncated: depth]"`.

### Fase 10 — o teto vira configurável, e sobe

Truncar sem subir o teto trocaria um vazamento por perda de cauda no 7º nível. O `MAX_WALK_NODES` já limita o
custo total desde a Fase 3, então a profundidade só precisa bastar contra pilha e contra `toJSON`
auto-projetante: **6 → 24**, com `createAroma({ maxDepth })` em `1..64`, rejeitado na construção em vez de
clampado. `DOMAIN_PLAN` continua sendo a constante compartilhada quando a opção é omitida — o caso comum não
ganha um plano novo.

A máscara por nome **não** trunca, e a distinção não é preferência: ela é heurística sobre um payload que a
conversão já tornou seguro, então um ramo que ela não alcançou está sem máscara e nada pior. Isso virou
`WalkPlan.truncateWhenBounded`.

### Fase 11 — o aviso de máscara também pelo canal que o operador lê

`console.warn` era a mitigação inteira, e quem descarta stderr nunca a via. Agora sai também como uma linha
`warn` marcada com `brandAsDiagnostic`, **pela pipeline**, uma vez por processo, com a mesma trava. Um preload
de teste (`test/claim-masking-warning.ts`) consome a trava antes das specs, senão a primeira delas encontraria
o aviso do próprio logger em `sink.events[0]`.

### Fase 12 — a varredura generativa

`src/internal/leak-sweep.spec.ts`: 20 formas × 5 posições, mais cada par aninhado, mais a escada de
profundidade, para as pipelines `[domain]` e `[domain, redact]` — com controle positivo. Quatro rodadas manuais
acharam quatro portas, cada uma no código que a rodada anterior tinha corrigido; a resposta para isso é
enumerar o espaço, não uma quinta rodada. Acrescentar uma forma nova ao ecossistema é acrescentar uma linha
aqui.

### Verificação destas fases

372 testes · 0 falhas · 99,90% de linhas · `tsc` e `knip` exit 0 · `bun run build` limpo · bench sem regressão
(dois casos novos: `deep-clean-16` 1,20 µs, `dto-rows` 1,52 µs) · sem retenção.

## Fora de escopo, registrado

- **Achado 7** (`Map`→objeto, `Set`→array). Decisão deliberada da 0.5.0: a preguiça do redact preservava um
  bug, já que `JSON.stringify(new Map())` é `{}`. Documentado como breaking; nada a corrigir.
- **Alvo por caminho pontuado** (`"user.password"`) no `createRedactProcessor`. Com a máscara opt-in, o falso
  positivo passou a ser escolha de quem liga. Feature aditiva se voltar a doer.
- **Descer em `Proxy` com trap hostil.** A Fase 1 impede que derrube a linha; blindar além disso exigiria
  detectar proxies, o que não é confiável em JS.
