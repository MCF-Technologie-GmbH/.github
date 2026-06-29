# Comandos del bot

Referencia de comandos y respuestas reales del Worker. Los comandos se ejecutan como comentarios en una issue; cuando el comando se procesa, el bot borra el comentario original.

## Metadata que maneja el bot

### `automation-state`

El estado de ramas se guarda en el body de la issue dentro de este bloque protegido:

```md
<!-- protected:start -->
<!-- automation-state:start
{
  "allowed_branch_name": "feat/123-add-login",
  "branch": {
    "exists": true,
    "linked": true,
    "error": null,
    "pr": 456
  }
}
automation-state:end -->
<!-- protected:end -->
```

| Campo | Que significa | Cuando cambia |
| --- | --- | --- |
| `allowed_branch_name` | Unica rama permitida para la issue. Se genera desde tipo, numero y titulo, por ejemplo `feat/123-add-login`. | Se crea/normaliza al ejecutar `/branch create`, `/branch repair` o al aceptar una rama creada desde la sidebar de GitHub. |
| `branch.exists` | Si el bot considera que la rama existe. | Pasa a `false` durante la reserva de `/branch create`; a `true` cuando la rama se crea o se acepta; a `false` si `/branch repair` detecta que la rama registrada no existe. |
| `branch.linked` | Si GitHub reporta la rama como linked branch de la issue. | Pasa a `true` cuando se crea/repara/acepta el enlace; pasa a `false` cuando falla la creacion o reparacion, o cuando `/branch repair` detecta que la rama registrada no existe. |
| `branch.error` | Ultimo error registrado para la rama. | Se limpia a `null` en reservas, creaciones, reparaciones y resets correctos. Se llena con el error resumido cuando falla crear o reparar, o con el mensaje del conflicto de estado. |
| `branch.pr` | Numero de PR asociado a la rama. | Se conserva al recrear/reparar ramas. Se actualiza al abrir un PR valido desde la rama autorizada. |

### `command-log:meta`

Cada respuesta que el bot publica puede llevar metadata oculta para construir el historial de comandos:

```md
<!-- command-log:meta
{"actor":"usuario","command":"/branch create","history":[]}
command-log:end -->
```

| Campo | Que significa | Cuando cambia |
| --- | --- | --- |
| `actor` | Usuario que ejecuto el comando o creo la rama manual. | Se toma de `comment.user.login` para slash commands y de `payload.sender.login` para eventos de rama. |
| `command` | Comando asociado a la respuesta. | Usa el comando real, por ejemplo `/branch create`, `/branch repair`, o `/branch manual`. |
| `history` | Respuestas anteriores del bot en la misma issue. | Antes de crear una nueva respuesta, el bot borra comentarios anteriores propios y los mete en el bloque desplegable `Command log`. |

## Items validos para comandos `requires`

| Item | Label pendiente |
| --- | --- |
| `Documentation` | `requires/docs` |
| `Tests` | `requires/tests` |
| `Release notes` | `requires/release-note` |
| `Security review` | `requires/security-review` |
| `Migration` | `requires/migration` |
| `CI` | `requires/ci` |
| `Config` | `requires/config` |

## Comandos de checklist

Estos comandos no publican una respuesta visible cuando son validos. Actualizan el body y labels, y devuelven internamente `{ processed: true, commandsProcessed: <n> }`.

| Comando | Para que sirve | Cambio real en body/labels | Respuesta real |
| --- | --- | --- | --- |
| `/require <item>` | Anade un item requerido como pendiente. | Si el item no existe, anade `- [ ] <item>` al bloque `Required updates`. El label `requires/*` correspondiente queda anadido si faltaba. | Sin comentario visible. Si no hay ningun comando valido: `reason: "no valid commands found"`. |
| `/unrequire <item>` | Quita un item requerido. | Si el item existe, elimina su linea del checklist. El label `requires/*` se elimina si ya no corresponde. | Sin comentario visible. Si no hay ningun comando valido: `reason: "no valid commands found"`. |
| `/resolve <item>` | Marca el item como resuelto. | Si existe, cambia a `- [x] <item>`. Si no existe, lo anade como `- [x] <item>`. El label `requires/*` se elimina. | Sin comentario visible. Si no hay ningun comando valido: `reason: "no valid commands found"`. |
| `/check <item>` | Alias de `/resolve <item>`. | Mismo cambio que `/resolve`. | Mismo resultado que `/resolve`. |
| `/unresolve <item>` | Marca el item como pendiente. | Si existe, cambia a `- [ ] <item>`. Si no existe, lo anade como `- [ ] <item>`. El label `requires/*` se anade. | Sin comentario visible. Si no hay ningun comando valido: `reason: "no valid commands found"`. |
| `/uncheck <item>` | Alias de `/unresolve <item>`. | Mismo cambio que `/unresolve`. | Mismo resultado que `/unresolve`. |

## Comandos de ramas

| Comando | Caso | Respuesta visible real | Cambio en `automation-state` |
| --- | --- | --- | --- |
| `/branch create` | Creacion correcta. | `Created linked branch:` + rama + `Base: dev`. | Reserva primero `{ allowed_branch_name, branch: { exists: false, linked: false, error: null, pr } }`. Al crear, cambia a `{ exists: true, linked: true, error: null }`. |
| `/branch create` | Ya existe `allowed_branch_name` distinto al esperado. | `This issue already has an assigned branch:` + rama registrada + `A second branch cannot be created for the same issue.` | Normaliza/inserta `allowed_branch_name` si faltaba, pero no crea otra rama. |
| `/branch create` | Hay metadata de rama existente pero la rama no esta enlazada y no se puede recrear automaticamente. | `This issue has recorded branch metadata, but the branch is not currently linked.` + `Recorded branch: ...` + `Run /branch repair...` | No cambia la metadata de rama salvo normalizacion previa del bloque. |
| `/branch create` | Ya hay rama autorizada. | `This issue already has an authorized branch:` + rama. | No cambia la metadata de rama salvo normalizacion previa del bloque. |
| `/branch create` | La reserva cambio mientras corria el comando. | `The branch reservation changed while processing /branch create. Please retry.` | Puede quedar la reserva escrita antes del reload; no marca `exists: true`. |
| `/branch create` | Falla crear la linked branch. | `I could not create the linked branch.` + `Branch: ...` + `Base: dev` + `The same branch can be retried with /branch create after the error is fixed.` + bloque `text` con el error. | Guarda `{ allowed_branch_name, branch: { exists: false, linked: false, error: "<error>", pr } }`. |
| `/branch create` | Estado de ramas bloquea la accion. | `Branch state needs attention before automation can continue.` + mensaje del conflicto + `Current state:` + instrucciones. | No cambia la metadata de rama salvo normalizacion previa del bloque. |
| `/branch repair` | No hay metadata y limpio stale linked branch records. | `Cleaned up stale linked branch records.` + `Removed records: <n>` + `No allowed branch metadata remains for this issue. You can now create the branch again.` | Puede normalizar el bloque, pero no crea `branch` si no habia metadata. |
| `/branch repair` | No hay metadata que reparar. | `Nothing to repair: this issue does not have recorded branch metadata.` | Puede crear/normalizar `allowed_branch_name`; `branch` queda `null`. |
| `/branch repair` | Estado de ramas bloquea la reparacion. | `Branch state needs attention before automation can continue.` + mensaje del conflicto + `Current state:` + instrucciones. | Guarda `branch.exists` segun si existe el ref registrado, `branch.linked` segun si esta enlazado, y `branch.error` con el mensaje del conflicto. |
| `/branch repair` | La rama registrada ya esta enlazada. | `No repair needed: the recorded branch is already linked.` + `Branch: ...`. | No cambia la metadata de rama salvo normalizacion previa. |
| `/branch repair` | La rama registrada no existe. | `Nothing to repair: the recorded branch does not exist.` + `Marked the branch state as missing so /branch create can be used again.` + `Allowed branch: ...`. | Guarda `{ branch: { exists: false, linked: false, error: null, pr } }` y conserva `allowed_branch_name`. |
| `/branch repair` | Reparacion correcta. | `Relinked branch successfully.` + `Branch: ...`. | Guarda `{ branch: { exists: true, linked: true, error: null, pr } }`. Durante el proceso crea una rama temporal `temp/...`, recrea la linked branch y borra la temporal. |
| `/branch repair` | Falla reparar la relacion linked branch. | `I could not repair the linked branch relationship.` + `Branch: ...` + `Temporary branch: ...` + `If the temporary branch still exists, the existing commits were preserved there.` + bloque `text` con el error. | Guarda `{ branch: { exists: true, linked: false, error: "<error>", pr } }`. |

### Plantillas exactas de respuestas de ramas

`/branch create` correcto:

```md
Created linked branch:

`<branchName>`

Base: `dev`
```

`/branch create` con otra rama asignada:

```md
This issue already has an assigned branch:

`<allowedBranchName>`

A second branch cannot be created for the same issue.
```

`/branch create` con metadata que necesita reparacion:

```md
This issue has recorded branch metadata, but the branch is not currently linked.

Recorded branch: `<allowedBranchName>`

Run `/branch repair` to repair the linked branch relationship or reset the metadata if the branch no longer exists.
```

`/branch create` cuando ya hay rama autorizada:

```md
This issue already has an authorized branch:

`<allowedBranchName o branchName>`
```

`/branch create` si cambia la reserva:

```md
The branch reservation changed while processing `/branch create`. Please retry.
```

`/branch create` si falla:

````md
I could not create the linked branch.

Branch: `<branchName>`
Base: `dev`

The same branch can be retried with `/branch create` after the error is fixed.

```text
<error>
```
````

`/branch repair` cuando limpia registros obsoletos sin metadata:

```md
Cleaned up stale linked branch records.

Removed records: `<deletedCount>`

No allowed branch metadata remains for this issue. You can now create the branch again.
```

`/branch repair` sin metadata:

```md
Nothing to repair: this issue does not have recorded branch metadata.
```

`/branch repair` cuando ya esta enlazada:

```md
No repair needed: the recorded branch is already linked.

Branch: `<branchName>`
```

`/branch repair` cuando la rama registrada no existe:

```md
Nothing to repair: the recorded branch does not exist.

Marked the branch state as missing so `/branch create` can be used again.

Allowed branch: `<branchName>`
```

`/branch repair` correcto:

```md
Relinked branch successfully.

Branch: `<branchName>`
```

`/branch repair` si falla:

````md
I could not repair the linked branch relationship.

Branch: `<branchName>`
Temporary branch: `<temporaryBranchName>`

If the temporary branch still exists, the existing commits were preserved there.

```text
<error>
```
````

### Mensajes de bloqueo de ramas

Cuando aparece `Branch state needs attention before automation can continue.`, el mensaje real incluye:

```md
Branch state needs attention before automation can continue.

<mensaje del conflicto>

Current state:
- Expected branch: `<expectedBranchName o none>`
- Recorded metadata: `<metadataName o none>`
- Linked branches: `<branch>` o `none`
- Stale linked records: `<n>`
- Expected git ref exists: `yes` / `no`

Run `/branch repair` or clean up the conflicting branch/link before retrying.
```

Si el conflicto es una linked branch sin git ref, la ultima linea cambia a:

```md
Remove the stale linked branch from the issue sidebar, then run `/branch repair` again.
```

Los mensajes de conflicto posibles son:

| Reason interno | Mensaje real |
| --- | --- |
| `multiple linked branches` | `GitHub reports multiple linked branches for this issue.` |
| `unexpected linked branch` | `GitHub reports an unexpected linked branch: <branch>.` |
| `metadata branch does not match expected branch` | `Recorded branch metadata points to <metadataName>, but the expected issue branch is <expectedBranchName>.` |
| `linked branch missing git ref` | `GitHub still reports <branch> as linked, but the git ref no longer exists.` |
| `unlinked git ref already exists` | `A git ref already exists for <expectedBranchName>, but GitHub does not report it as linked to this issue.` |

## Eventos automaticos relacionados

| Evento | Caso | Respuesta visible real | Cambio en metadata |
| --- | --- | --- | --- |
| Creacion de rama | No es `ref_type: branch`. | No comenta. Devuelve `reason: "create ref_type=<tipo>"`. | Ninguno. |
| Creacion de rama por el bot | Es rama temporal de reparacion `temp/...-YYYYMMDDHHMMSS`. | No comenta. Devuelve `reason: "temporary repair branch created by automation bot"`. | Ninguno. |
| Creacion de rama por el bot | Coincide con `allowed_branch_name`. | No comenta. Devuelve `reason: "branch created by automation bot with matching reservation"`. | Ninguno en este handler; `/branch create` actualiza despues. |
| Creacion manual de rama desde sidebar | Rama linked, basada en `dev`, nombre esperado y sin metadata conflictiva. | `Branch linked and recorded successfully.` + `Branch: ...` + `Base: dev` + `Created from GitHub's sidebar and accepted by automation.` | Guarda `{ allowed_branch_name: branchName, branch: { exists: true, linked: true, error: null, pr } }`. |
| Creacion manual de rama desde sidebar | Rama linked, basada en `dev`, nombre esperado y coincide con metadata previa. | `Branch manually linked and metadata repaired successfully.` + `Branch: ...` + `Base: dev` + `Created from GitHub's sidebar and accepted by automation.` | Guarda `{ allowed_branch_name: branchName, branch: { exists: true, linked: true, error: null, pr } }`. |
| Creacion manual de rama desde sidebar | Hay metadata apuntando a otra rama. | `Deleted manually linked branch <branch>.` + `This issue already has recorded branch metadata:` + rama registrada + `Run /branch repair before creating or linking a different branch manually.` | Borra la nueva rama. No cambia `automation-state`. |
| Creacion manual de rama | Rama no aceptada por automation. | `Deleted branch <branch> because it was not accepted by automation.` + `Prefer /branch create for managed issue branches, or use the GitHub sidebar only when the generated branch name matches the issue convention and no branch is already recorded.` | Borra la rama. No cambia `automation-state`. |
| Apertura de PR | Action distinta de `opened`. | No comenta. Devuelve `reason: "pull_request action=<action>"`. | Ninguno. |
| Apertura de PR | La rama del PR no parece gestionada por issue. | No comenta. Devuelve `reason: "PR branch is not issue-managed"`. | Ninguno. |
| Apertura de PR | PR valido. | No comenta. Devuelve `{ processed: true, valid: true, issue, pr }`. | Actualiza `branch.pr` con el numero del PR. |
| Apertura de PR | PR invalido. | `This PR is not fully linked to its issue yet:` seguido de una lista de problemas. | No actualiza `branch.pr`. |

### Plantillas exactas de eventos automaticos

Rama aceptada desde la sidebar:

```md
Branch linked and recorded successfully.

Branch: `<branchName>`
Base: `dev`

Created from GitHub's sidebar and accepted by automation.
```

Rama manual que repara metadata existente:

```md
Branch manually linked and metadata repaired successfully.

Branch: `<branchName>`
Base: `dev`

Created from GitHub's sidebar and accepted by automation.
```

Rama manual borrada porque ya habia otra metadata:

```md
Deleted manually linked branch `<branchName>`.

This issue already has recorded branch metadata:

`<allowedBranchName>`

Run `/branch repair` before creating or linking a different branch manually.
```

Rama manual no aceptada:

```md
Deleted branch `<branchName>` because it was not accepted by automation.

Prefer `/branch create` for managed issue branches, or use the GitHub sidebar only when the generated branch name matches the issue convention and no branch is already recorded.
```

PR invalido:

```md
This PR is not fully linked to its issue yet:

- <problema>
```

Problemas reales que puede listar un PR invalido:

| Problema |
| --- |
| `<mensaje del conflicto de ramas>` |
| `the source branch is not registered as an authorized linked branch for this issue` |
| ``the PR base must be `dev` `` |
| ``the PR body must reference this issue, for example `Refs #<issueNumber>` `` |
| `this issue is already associated with PR #<prNumber>` |

## Proteccion de comentarios del bot

| Evento | Respuesta visible | Resultado interno |
| --- | --- | --- |
| Editan un comentario del bot | No crea comentario nuevo; restaura el body anterior. | `{ processed: true, protected: true, operation: "restored edited bot comment" }` |
| Borran un comentario del bot | Recrea el comentario borrado sin decorar el command log. | `{ processed: true, protected: true, operation: "recreated deleted bot comment" }` |
| Editan o borran comentario de usuario | No hace nada. | `reason: "comment is not owned by automation bot"` |
