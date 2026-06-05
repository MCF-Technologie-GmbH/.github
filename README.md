# MCF Technologie GmbH — `.github` Repository

This repository contains organization-wide GitHub configuration for **MCF Technologie GmbH**.

## Contents

| Path                                                  | Description                                                                   |
|-------------------------------------------------------|-------------------------------------------------------------------------------|
| [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/)  | Issue form templates for all repositories                                     |
| [`taxonomy/`](taxonomy/)                              | YAML files defining the organization's issue types and fields                 |
| [`scripts/`](scripts/)                                | Automation scripts for validation and synchronization                         |
| [`cloudflare-worker/`](cloudflare-worker/)            | Cloudflare Worker that enforces issue type policies and handles automations   |

---

## Taxonomy as Code

The organization's metadata (Issue Types and Issue Fields) is managed declaratively via YAML files in the [`taxonomy/`](taxonomy/) directory.

- **`issue-types.yml`**: Defines names, descriptions, and colors for all available types.
- **`issue-fields.yml`**: Defines custom fields (`Scope`, `Priority`, `Effort`, etc.) and their data types.
- **`issue-type-fields.yml`**: Maps which fields should be pinned (visible in the sidebar) for each issue type.
- **`scopes.txt`**: Single source of truth for the codebase scopes (areas affected). Shared across all templates.

### Synchronization Flow

1. **Change:** A developer modifies a YAML file or `scopes.txt` in a Pull Request.
2. **Validate:** GitHub Actions runs [`validate-taxonomy.mjs`](scripts/validate-taxonomy.mjs) to ensure data integrity and reference consistency.
3. **Generate:** The script [`update-template-scopes.mjs`](scripts/update-template-scopes.mjs) is used to automatically populate the `Scope` dropdown in all issue templates from `scopes.txt`.
4. **Dry Run:** On PRs, the sync script can be run in `DRY_RUN=true` mode to report what changes would be applied.
5. **Apply:** Once merged to `main`, GitHub Actions runs [`sync-taxonomy.mjs`](scripts/sync-taxonomy.mjs) using the GraphQL API to reconcile the organization's state.

> [!NOTE]
> While types and fields are created/updated automatically, **Pinned Fields** currently require manual assignment in the GitHub UI (drift is reported but not applied due to API limitations).

---

## Standard Issue Templates

Seven templates are available when creating issues across any repository in the organization. Each template automatically sets the correct Issue Type on creation and adds the issue to the *Softwareentwicklung* project board.

| Template | Issue Type | Commit Prefix | When to use |
| -------- | ---------- | ------------- | ----------- |
| Bug | `Bug` | `fix` | Unexpected error, defect, or incorrect behavior |
| Feature | `Feature` | `feat` | New functional or technical capability |
| Refactor | `Refactor` | `refactor` | Internal code restructuring or debt reduction without behavior changes |
| Test | `Test` | `test` | Adding, improving, or repairing test suites |
| Documentation | `Documentation` | `docs` | Modifying docs, guides, or release notes |
| Chore | `Chore` | `chore` | Routine tasks, dependency updates, CI config, repo maintenance |
| Spike | `Spike` | `spike` | Timeboxed technical investigation to reduce uncertainty |

---

## Automation & Conventions

We enforce a strict **Type + Scope + Requires** semantic model using a Cloudflare Worker:

### 1. Title Auto-Prefixing (Conventional Commits)
Developers write normal titles when creating issues. The Worker automatically reads the issue type and selected `Scope`, and rewrites the title to: `type(scope): description`.
*Example: Creating a Bug issue with scope `ui` and title `fix login error` gets automatically renamed to `fix(ui): fix login error`.*

### 2. Scope Field Syncing & Immutability
The selected `Scope` is parsed from the body on creation and synced directly to the organization-level **`Scope`** single-select Issue Field. The Scope is **immutable** after creation; subsequent edits to the scope tag in the title are automatically reverted to the original, and the sidebar is kept in sync using the title's scope as the source of truth.

### 3. Required Updates Checklist
Issues contain a **Required updates** checklist in their description body (Documentation, Tests, Release notes, Security review, etc.).
- When an item is pending (`[ ]`), the Worker adds the `requires/<item>` label.
- When an item is marked as resolved (`[x]`), the label is removed.
- **Auto-healing:** Manual deletion of checklist lines is automatically restored by the Worker. Invalid additions are removed.

### 4. Comment Command Interface
Developers can modify the checklist structurally or change item statuses by commenting on the issue:
- `/require <item>`: Adds `<item>` as pending.
- `/unrequire <item>`: Removes `<item>` from the checklist.
- `/resolve <item>` or `/check <item>`: Marks `<item>` as completed.
- `/unresolve <item>` or `/uncheck <item>`: Marks `<item>` as pending.

The Worker processes these comments, updates the issue body/labels, and then deletes the comment to keep the timeline clean.

For details on the worker implementation, see [`cloudflare-worker/README.md`](cloudflare-worker/README.md).
