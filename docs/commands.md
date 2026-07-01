# Comandos del bot

Referencia de comandos y respuestas reales del Worker. Los comandos se ejecutan como comentarios en una issue; cuando el comando se procesa, el bot borra el comentario original.

## Metadata que maneja el bot

### `automation-state`

El estado de ramas se guarda en el body de la issue dentro de este bloque protegido:

```md
<!-- protected:start -->
<!-- automation-state:start
{
  "original_issue_type": "Feature",
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
| `original_issue_type` | Issue Type original de la issue. Es la fuente estable para revertir cambios manuales de type sin depender del timeline de GitHub. | Se guarda cuando el Worker crea o normaliza el `automation-state`. |
| `allowed_branch_name` | Nombre esperado/autorizado para la unica rama gestionada de la issue. Se genera desde tipo, numero y titulo, por ejemplo `feat/123-add-login`. | Se crea/normaliza al ejecutar `/branch create`, `/branch repair`, `/branch delete`, al aceptar una rama creada desde la sidebar de GitHub, o al cambiar el titulo mientras no exista una branch gestionada. |
| `branch.exists` | Si el bot considera que la rama existe. | Pasa a `false` durante la reserva de `/branch create`; a `true` cuando la rama se crea o se acepta; a `false` si `/branch repair` detecta que la rama registrada no existe o si `/branch delete` la borra/resetea. |
| `branch.linked` | Si GitHub reporta la rama como linked branch de la issue. | Pasa a `true` cuando se crea/repara/acepta el enlace; pasa a `false` cuando falla la creacion o reparacion, o cuando `/branch repair` detecta que la rama registrada no existe. |
| `branch.error` | Ultimo error registrado para la rama. | Se limpia a `null` en reservas, creaciones, reparaciones y resets correctos. Se llena con el error resumido cuando falla crear o reparar, o con el mensaje del conflicto de estado. |
| `branch.pr` | Numero de PR activo asociado a la rama. | Se actualiza al abrir un PR valido desde la rama autorizada. Pasa a `null` cuando `/branch delete` cierra el PR o cuando se limpia metadata. |

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
| `history` | Respuestas anteriores del bot en la misma issue. | Antes de crear una nueva respuesta final, el bot borra comentarios anteriores propios y los mete en el bloque desplegable `Command log`. No debe quedar un comentario base duplicado sin log. |

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
| `/branch create` | Creacion correcta. | `Created linked branch:` + rama + `Base: dev` + mensaje de que el Draft PR se creara despues del primer push. | Reserva primero `{ allowed_branch_name, branch: { exists: false, linked: false, error: null, pr: null } }`. Antes de crear la linked branch, archiva PRs cerrados antiguos por `head=<branchName>` que correspondan a la issue. Despues crea la linked branch y guarda `{ exists: true, linked: true, error: null, pr: null }`. |
| `/branch create` | Ya existe una linked branch. | `This issue already has a linked branch:` + rama + `Each issue can only manage one branch.` + instrucciones para usar `/branch delete`. | Sincroniza metadata con el estado real antes de responder. |
| `/branch create` | La expected branch existe, pero GitHub no la reporta como linked. | `The expected branch exists, but GitHub no longer reports it as linked to this issue.` + expected branch + `Run /branch repair...` + `Run /branch delete... This cannot be undone.` | Sincroniza metadata a `{ exists: true, linked: false, error: null }`. |
| `/branch create` | Ya hay expected branch linkeada. | `This issue already has an authorized branch:` + rama. | No cambia la metadata de rama salvo normalizacion previa del bloque. |
| `/branch create` | La reserva cambio mientras corria el comando. | `The branch reservation changed while processing /branch create. Please retry.` | Puede quedar la reserva escrita antes del reload; no marca `exists: true`. |
| `/branch create` | Falla crear la linked branch. | `I could not create the linked branch.` + `Branch: ...` + `Base: dev` + `The same branch can be retried with /branch create after the error is fixed.` + bloque `text` con el error. | Guarda `{ allowed_branch_name, branch: { exists: false, linked: false, error: "<error>", pr } }`. |
| `/branch create` | Estado de ramas bloquea la accion. | Mensaje especifico del conflicto, por ejemplo linked branch existente, nombre invalido o stale link. | Sincroniza metadata con el estado real antes de responder. |
| `/branch repair` | No hay metadata y limpio stale linked branch records. | `Cleaned up stale linked branch records.` + `Removed records: <n>` + `No allowed branch metadata remains for this issue. You can now create the branch again.` | Puede normalizar el bloque, pero no crea `branch` si no habia metadata. |
| `/branch repair` | No hay metadata que reparar. | `Nothing to repair: this issue does not have branch metadata.` | Puede crear/normalizar `allowed_branch_name`; `branch` queda `null`. |
| `/branch repair` | Estado de ramas bloquea la reparacion. | Mensaje especifico del conflicto, por ejemplo linked branch existente, expected branch sin link o stale link. | Guarda `branch.exists` segun si existe el ref esperado, `branch.linked` segun si esta enlazado, y `branch.error` con el mensaje del conflicto. |
| `/branch repair` | La expected branch ya esta enlazada. | `No repair needed: the expected branch is already linked.` + `Branch: ...`. | No cambia la metadata de rama salvo normalizacion previa. |
| `/branch repair` | La expected branch no existe. | `Nothing to repair: the expected branch does not exist.` + `Marked the branch state as missing so /branch create can be used again.` + `Expected branch: ...`. | Guarda `{ branch: { exists: false, linked: false, error: null, pr } }` y conserva `allowed_branch_name`. |
| `/branch repair` | Reparacion correcta. | `Relinked branch successfully.` + `Branch: ...`. | Guarda `{ branch: { exists: true, linked: true, error: null, pr } }`. Durante el proceso crea una rama temporal `temp/...`, recrea la linked branch y borra la temporal. |
| `/branch repair` | Falla reparar la relacion linked branch despues de crear la temporal. | `I could not repair the linked branch relationship.` + `Branch: ...` + `Temporary branch: ...` + mensaje indicando si la rama original existe otra vez o si la temporal conserva el backup + bloque `text` con el error. | Si el ref original existe otra vez, borra `temp/...` y guarda `{ branch: { exists: true, linked: false, error: "<error>", pr } }`. Si no existe, conserva `temp/...` como backup y guarda `exists: false`. |
| `/branch delete` | Hay linked branch visible o expected branch existente. | `Deleted the branch managed for this issue.` + `Branch: ...` + `This cannot be undone by automation.` | Si hay PR activo, lo cierra pero conserva su body/link para permitir `Restore branch` desde el PR cerrado. Borra la linked branch visible si existe; si no, borra `heads/<allowed_branch_name>`. Limpia linked branch records obsoletos y guarda `{ branch: { exists: false, linked: false, error: null, pr: null } }`. |
| `/branch delete` | Hay metadata pero el ref ya no existe. | `The managed branch did not exist, so I only reset the branch metadata.` + `Branch: ...` + `This cannot be undone by automation.` | Limpia linked branch records obsoletos y guarda `{ branch: { exists: false, linked: false, error: null, pr } }`. |
| `/branch delete` | No hay metadata de rama. | `Nothing to delete: this issue does not have branch metadata.` | Puede normalizar el bloque, pero no crea `branch`. |

## Edicion de issues

| Evento | Caso | Respuesta visible real | Cambio en `automation-state` |
| --- | --- | --- | --- |
| Editar titulo | No existe branch gestionada (`branch` vacio o `exists: false`, `linked: false`, `pr: null`). | Sin comentario visible. | Recalcula `allowed_branch_name` con el titulo nuevo. |
| Editar titulo | Existe branch gestionada, incluso si `exists: true` y `linked: false`. | `The issue title cannot be changed while a managed branch exists.` + managed branch + instrucciones para usar `/branch delete`. | Revierte el titulo al valor anterior y conserva `allowed_branch_name`. |

Mensaje exacto cuando el titulo queda bloqueado:

```md
The issue title cannot be changed while a managed branch exists.

Managed branch: `<allowedBranchName>`

Delete the existing branch with `/branch delete` before changing the title.

Deleting a branch cannot be undone by automation.
```

### Plantillas exactas de respuestas de ramas

`/branch create` correcto:

```md
Created linked branch:

`<branchName>`

Base: `dev`

A draft PR will be created automatically after the first push with commits.
```

`/branch create` cuando ya hay linked branch:

```md
This issue already has a linked branch:

`<linkedBranchName>`

Each issue can only manage one branch.

If you want to create a new branch, first delete the existing branch with `/branch delete`.

Deleting a branch cannot be undone by automation.
```

`/branch create` cuando la expected branch existe pero no esta linkeada:

```md
The expected branch exists, but GitHub no longer reports it as linked to this issue.

Expected branch:

`<expectedBranchName>`

Run `/branch repair` to relink it.
Run `/branch delete` only if you want to permanently delete it. This cannot be undone.
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

Cuando se reciba el primer push con commits entre la rama y `dev`, el Draft PR debe usar:

| Campo | Valor |
| --- | --- |
| Title | `<type>: <titulo original de la issue sin prefijo conventional previo>` |
| Body | `Refs #<issueNumber>` |
| Base | `dev` |
| Head | `<branchName>` |
| Draft | `true` |

`/branch repair` cuando limpia registros obsoletos sin metadata:

```md
Cleaned up stale linked branch records.

Removed records: `<deletedCount>`

No allowed branch metadata remains for this issue. You can now create the branch again.
```

`/branch repair` sin metadata:

```md
Nothing to repair: this issue does not have branch metadata.
```

`/branch repair` cuando ya esta enlazada:

```md
No repair needed: the expected branch is already linked.

Branch: `<branchName>`
```

`/branch repair` cuando la expected branch no existe:

```md
Nothing to repair: the expected branch does not exist.

Marked the branch state as missing so `/branch create` can be used again.

Expected branch: `<branchName>`
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

The original branch ref exists again, so the temporary backup branch was removed.

```text
<error>
```
````

`/branch delete` correcto:

```md
Deleted the branch managed for this issue.

Branch: `<branchName>`

Closed associated pull request: <prNumber>

This cannot be undone by automation.
```

La linea `Closed associated pull request` solo aparece si habia un PR activo asociado.

`/branch delete` cuando el ref ya no existe:

```md
The managed branch did not exist, so I only reset the branch metadata.

Branch: `<branchName>`

This cannot be undone by automation.
```

`/branch delete` sin metadata:

```md
Nothing to delete: this issue does not have branch metadata.
```

### Mensajes de bloqueo de ramas

Los conflictos mas comunes usan mensajes especificos:

```md
This issue already has a linked branch:

`<linkedBranchName>`

Each issue can only manage one branch.

If you want to create a new branch, first delete the existing branch with `/branch delete`.

Deleting a branch cannot be undone by automation.
```

```md
This branch name is not valid for this issue.

Expected branch:

`<expectedBranchName>`

Received branch:

`<receivedBranchName>`

Use `/branch create` to create the correct branch automatically.
```

```md
The expected branch exists, but GitHub no longer reports it as linked to this issue.

Expected branch:

`<expectedBranchName>`

Run `/branch repair` to relink it.
Run `/branch delete` only if you want to permanently delete it. This cannot be undone.
```

Los mensajes de conflicto posibles son:

| Reason interno | Mensaje real |
| --- | --- |
| `multiple linked branches` | `GitHub reports multiple linked branches for this issue.` |
| `unexpected linked branch` | `This issue already has a linked branch:` + rama + instrucciones para `/branch delete`. |
| `metadata branch does not match expected branch` | `The expected branch name for this issue changed.` + expected branch + current metadata branch. |
| `linked branch missing git ref` | `GitHub reports a linked branch for this issue, but the branch no longer exists.` + linked branch + `/branch repair`. |
| `unlinked git ref already exists` | `The expected branch already exists, but GitHub does not report it as linked to this issue.` + `/branch repair`. |

## Eventos automaticos relacionados

| Evento | Caso | Respuesta visible real | Cambio en metadata |
| --- | --- | --- | --- |
| Creacion de rama | No es `ref_type: branch`. | No comenta. Devuelve `reason: "create ref_type=<tipo>"`. | Ninguno. |
| Creacion de rama por el bot | Es rama temporal de reparacion `temp/...-YYYYMMDDHHMMSS`. | No comenta. Devuelve `reason: "temporary repair branch created by automation bot"`. | Ninguno. |
| Creacion de rama por el bot | Coincide con `allowed_branch_name`. | No comenta. Devuelve `reason: "branch created by automation bot with matching reservation"`. | Ninguno en este handler; `/branch create` actualiza despues. |
| Creacion manual de rama desde sidebar | Rama linked, basada en `dev`, nombre esperado y sin metadata conflictiva. | `Branch linked and recorded successfully.` + `Branch: ...` + `Base: dev` + mensaje de Draft PR + `Created from GitHub's sidebar and accepted by automation.` | Archiva PRs cerrados antiguos por `head=<branchName>` que correspondan a la issue y guarda `{ allowed_branch_name: branchName, branch: { exists: true, linked: true, error: null, pr: null } }`. |
| Creacion manual de rama desde sidebar | Rama linked, basada en `dev`, nombre esperado y coincide con metadata previa. | `Branch manually linked and metadata repaired successfully.` + `Branch: ...` + `Base: dev` + mensaje de Draft PR + `Created from GitHub's sidebar and accepted by automation.` | Archiva PRs cerrados antiguos por `head=<branchName>` que correspondan a la issue y guarda `{ allowed_branch_name: branchName, branch: { exists: true, linked: true, error: null, pr: null } }`. |
| Creacion manual de rama desde sidebar | Hay metadata apuntando a otra rama. | `Deleted manually linked branch <branch>.` + `This issue already has expected branch metadata:` + expected branch + `Run /branch repair before creating or linking a different branch manually.` | Borra la nueva rama. No cambia `automation-state`. |
| Creacion manual de rama | Rama no aceptada por automation. | `Deleted branch <branch> because it was not accepted by automation.` + `Prefer /branch create for managed issue branches, or use the GitHub sidebar only when the generated branch name matches the issue convention and no branch is already managed.` | Borra la rama. No cambia `automation-state`. |
| Push a rama gestionada | La rama autorizada ya tiene commits contra `dev` y no hay PR registrado. | `Created draft PR:` + numero de PR + `Branch: ...` + `Base: dev`. | Primero archiva PRs cerrados antiguos por `head=<branchName>` que correspondan a la issue. Despues crea un Draft PR nuevo y actualiza `branch.pr` con ese numero. |
| Push a rama gestionada | La rama todavia apunta al mismo commit que `dev`. | No comenta. Devuelve `reason: "no commits between branch and base"`. | No cambia metadata. |
| Push a rama gestionada | Ya hay PR registrado en metadata. | No comenta. Devuelve `reason: "draft pull request already recorded"`. | No cambia metadata. |
| Push a rama con numero de issue | La rama no esta autorizada para esa issue. | `I did not create a draft PR for this push because the branch is not registered as the authorized linked branch for the issue.` + expected branch y metadata branch. | No cambia metadata. |
| Push a rama gestionada | Falla crear el Draft PR. | `I could not create the draft PR for this branch push.` + `Branch: ...` + `Base: dev` + bloque `text` con el error. | Guarda `branch.error` con el error y conserva `branch.pr`. |
| Apertura de PR | Action distinta de `opened`. | No comenta. Devuelve `reason: "pull_request action=<action>"`. | Ninguno. |
| Apertura de PR | La rama del PR no parece gestionada por issue. | No comenta. Devuelve `reason: "PR branch is not issue-managed"`. | Ninguno. |
| Apertura de PR | PR valido. | No comenta salvo que tenga que normalizar title/body. Devuelve `{ processed: true, valid: true, issue, pr }`. | Normaliza title/body, archiva PRs cerrados antiguos por `head=<branchName>` que correspondan a la issue y actualiza `branch.pr` con el numero del PR activo. |
| Apertura de PR | PR invalido. | `This PR is not fully linked to its issue yet:` seguido de una lista de problemas. | No actualiza `branch.pr`. |

### Plantillas exactas de eventos automaticos

Rama aceptada desde la sidebar:

```md
Branch linked and recorded successfully.

Branch: `<branchName>`
Base: `dev`
A draft PR will be created automatically after the first push with commits.

Created from GitHub's sidebar and accepted by automation.
```

Rama manual que repara metadata existente:

```md
Branch manually linked and metadata repaired successfully.

Branch: `<branchName>`
Base: `dev`
A draft PR will be created automatically after the first push with commits.

Created from GitHub's sidebar and accepted by automation.
```

Push correcto que crea Draft PR:

```md
Created draft PR:

Pull request number: <prNumber>

Branch: `<branchName>`
Base: `dev`
```

Push autorizado pero falla crear Draft PR:

````md
I could not create the draft PR for this branch push.

Branch: `<branchName>`
Base: `dev`

```text
<error>
```
````

Rama manual borrada porque ya habia otra expected branch:

```md
Deleted manually linked branch `<branchName>`.

This issue already has expected branch metadata:

`<allowedBranchName>`

Run `/branch repair` before creating or linking a different branch manually.
```

Rama manual no aceptada:

```md
Deleted branch `<branchName>` because it was not accepted by automation.

Prefer `/branch create` for managed issue branches, or use the GitHub sidebar only when the generated branch name matches the issue convention and no branch is already managed.
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
