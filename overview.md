# System Overview — MCF GitHub Automation Platform

> **Repository:** `MCF-Technologie-GmbH/.github`
> **Last updated:** 2026-06-03

This document is a single-source technical overview of how the `.github` repository works end-to-end. It covers every component, how they relate to each other, and the data flows that connect them.

---

## Table of Contents

1. [Purpose](#1-purpose)
2. [Repository Structure](#2-repository-structure)
3. [Taxonomy as Code](#3-taxonomy-as-code)
   - 3.1 [Issue Types](#31-issue-types)
   - 3.2 [Issue Fields](#32-issue-fields)
   - 3.3 [Pinned Fields per Type](#33-pinned-fields-per-type)
   - 3.4 [Scopes (Centralized List)](#34-scopes-centralized-list)
   - 3.5 [Required Updates (Centralized List)](#35-required-updates-centralized-list)
4. [Issue Templates](#4-issue-templates)
   - 4.1 [Available Templates](#41-available-templates)
   - 4.2 [Template Anatomy](#42-template-anatomy)
   - 4.3 [Template Configuration](#43-template-configuration)
5. [Cloudflare Worker (Automation Bot)](#5-cloudflare-worker-automation-bot)
   - 5.1 [Architecture](#51-architecture)
   - 5.2 [Dynamic Resolution](#52-dynamic-resolution)
   - 5.3 [Projects Repository Policy](#53-projects-repository-policy)
   - 5.4 [Codebase Repository Policy](#54-codebase-repository-policy)
   - 5.5 [Title Auto-Prefixing](#55-title-auto-prefixing)
   - 5.6 [Scope Field Syncing](#56-scope-field-syncing)
   - 5.7 [Required Updates Checklist](#57-required-updates-checklist)
   - 5.8 [Comment Command Interface](#58-comment-command-interface)
   - 5.9 [Template Type Detection](#59-template-type-detection)
   - 5.10 [Issue Body Zoning & Reversion Policy](#510-issue-body-zoning--reversion-policy)
6. [Automation Scripts](#6-automation-scripts)
   - 6.1 [validate-taxonomy.mjs](#61-validate-taxonomymjs)
   - 6.2 [sync-taxonomy.mjs](#62-sync-taxonomymjs)
   - 6.3 [update-template-scopes.mjs](#63-update-template-scopesmjs)
7. [End-to-End Data Flow](#7-end-to-end-data-flow)
   - 7.1 [Taxonomy Change Flow](#71-taxonomy-change-flow)
   - 7.2 [Issue Creation Flow](#72-issue-creation-flow)
   - 7.3 [Issue Edit / Type Change Flow](#73-issue-edit--type-change-flow)
   - 7.4 [Comment Command Flow](#74-comment-command-flow)
8. [Infrastructure & Secrets](#8-infrastructure--secrets)
9. [Known Limitations](#9-known-limitations)

---

## 1. Purpose

This repository is the **organization-wide `.github` repository** for MCF Technologie GmbH. GitHub automatically applies its contents (issue templates, workflows, configuration) to **every repository** in the organization that does not define its own overrides.

Beyond templates, this repo hosts the full **Taxonomy-as-Code** system and a **Cloudflare Worker** that together enforce a strict **Type + Scope + Requires** semantic model on all GitHub Issues across the organization.

---

## 2. Repository Structure

```text
.github/
├── .github/
│   └── ISSUE_TEMPLATE/           # Issue form templates (YAML)
│       ├── config.yml            # Disables blank issues
│       ├── bug.yml
│       ├── feature.yml
│       ├── refactor.yml
│       ├── test.yml
│       ├── documentation.yml
│       ├── chore.yml
│       └── spike.yml
├── taxonomy/                     # Declarative metadata definitions
│   ├── issue-types.yml           # Issue type names, colors, descriptions
│   ├── issue-fields.yml          # Custom fields (Priority, Scope, Effort…)
│   ├── issue-type-fields.yml     # Pinned field mapping per issue type
│   ├── scopes.txt                # Centralized scope whitelist
│   ├── required-updates.txt      # Centralized required updates whitelist
│   └── README.md
├── scripts/                      # Node.js automation scripts
│   ├── validate-taxonomy.mjs     # YAML validation & cross-reference checks
│   ├── sync-taxonomy.mjs         # GraphQL reconciler (org ↔ YAML)
│   ├── update-template-scopes.mjs # Propagates scopes.txt and required-updates.txt -> templates/fields
│   └── README.md
├── cloudflare-worker/            # Webhook-powered automation
│   ├── src/                      # Modular ES Modules source directory
│   │   ├── index.js              # Webhook entrypoint & routing
│   │   ├── config.js             # Whitelists & constant configurations
│   │   ├── handlers/             # Event handlers (issues, comments)
│   │   ├── services/             # GitHub Client & token generation
│   │   └── utils/                # Crypto, text, and checklist helpers
│   ├── wrangler.toml             # Cloudflare deployment config
│   └── README.md
├── package.json                  # npm scripts: validate, sync, sync:dry
├── .gitignore
├── README.md                     # Project-level readme
└── overview.md                   # ← This file
```

---

## 3. Taxonomy as Code

The organization's GitHub metadata is managed declaratively through YAML files in [`taxonomy/`](taxonomy/). No IDs are stored in these files — GitHub assigns IDs, and scripts resolve them at runtime by name.

### 3.1 Issue Types

**File:** [`taxonomy/issue-types.yml`](taxonomy/issue-types.yml)

Eight issue types are defined:

| Key | Name | Color | Purpose |
| :--- | :--- | :--- | :--- |
| `chore` | Chore | YELLOW | Routine tasks, tooling, dependencies, CI/CD, repo maintenance |
| `bug` | Bug | RED | Unexpected errors, defects, incorrect behavior |
| `feature` | Feature | BLUE | New functional or technical capabilities |
| `refactor` | Refactor | ORANGE | Internal code restructuring without behavior changes |
| `test` | Test | GREEN | Adding, improving, or repairing test suites |
| `spike` | Spike | GRAY | Timeboxed technical investigation to reduce uncertainty |
| `documentation` | Documentation | PURPLE | Writing or modifying docs, guides, API specs, release notes |
| `project` | Project | BLUE | High-level planning container (Epics). Reserved for the `projects` repo |

### 3.2 Issue Fields

**File:** [`taxonomy/issue-fields.yml`](taxonomy/issue-fields.yml)

Seven organization-level custom fields are defined:

| Key | Name | Data Type | Notes |
| :--- | :--- | :--- | :--- |
| `priority` | Priority | SINGLE_SELECT | P0 (Critical) → P3 (Low) |
| `start_date` | Start date | DATE | — |
| `target_date` | Target date | DATE | — |
| `effort` | Effort | SINGLE_SELECT | E1 (Mini) → E13 (Very large / needs splitting) |
| `customer` | Customer | SINGLE_SELECT | Luetze, Harman, Audi, Samson, B.Braun |
| `project_id` | Project ID | TEXT | Free-text identifier |
| `scope` | Scope | SINGLE_SELECT | Codebase area (must match `scopes.txt`) |

### 3.3 Pinned Fields per Type

**File:** [`taxonomy/issue-type-fields.yml`](taxonomy/issue-type-fields.yml)

Defines which fields appear in the **sidebar** for each issue type. These are called "Pinned Fields" in the GitHub UI.

| Issue Type | Pinned Fields |
| :--- | :--- |
| Chore, Bug, Feature, Refactor, Test, Spike, Documentation | `priority`, `scope`, `effort`, `start_date`, `target_date` |
| Project | `customer`, `project_id`, `start_date`, `target_date` |

> [!NOTE]
> The GraphQL API exposes pinned fields as **read-only**. The sync script reports drift but cannot programmatically update pinned field assignments. Manual changes must be made in:
> **Organization Settings → Issue types → Select type → Manage pinned fields**

### 3.4 Scopes (Centralized List)

**File:** [`taxonomy/scopes.txt`](taxonomy/scopes.txt)

A plain-text file listing every valid scope, one per line. This is the **single source of truth** shared by:
- The `Scope` dropdown in all issue templates
- The `scope` field options in `issue-fields.yml`

Current scopes:
```
ui, api, backend, frontend, ci, gha, worker, deps, repo, tooling, infra, deploy, docs, config, security
```

The validation script (`validate-taxonomy.mjs`) cross-checks that `scopes.txt` and `issue-fields.yml` contain identical scope values.

### 3.5 Required Updates (Centralized List)

**File:** [`taxonomy/required-updates.txt`](taxonomy/required-updates.txt)

A plain-text file listing every valid required update item, one per line. This is the **single source of truth** shared by:
- The `Required updates` checkboxes in all relevant issue templates
- The `REQUIRES_WHITELIST` in `cloudflare-worker/src/config.js` (validated offline)

Current required updates:
```text
Documentation
Tests
Release notes
Security review
Migration
CI
Config
```

The validation script (`validate-taxonomy.mjs`) cross-checks that `required-updates.txt` matches the exact whitelist keys in the Cloudflare Worker.

---

## 4. Issue Templates

### 4.1 Available Templates

Seven YAML-based issue form templates live in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). Blank issues are disabled via `config.yml`.

| Template File | Name | Issue Type | Commit Prefix | When to Use |
| :--- | :--- | :--- | :--- | :--- |
| `bug.yml` | Bug | `Bug` | `fix` | Unexpected error, defect, or incorrect behavior |
| `feature.yml` | Feature | `Feature` | `feat` | New functional or technical capability |
| `refactor.yml` | Refactor | `Refactor` | `refactor` | Internal code restructuring or debt reduction |
| `test.yml` | Test | `Test` | `test` | Adding, improving, or repairing test suites |
| `documentation.yml` | Documentation | `Documentation` | `docs` | Modifying docs, guides, or release notes |
| `chore.yml` | Chore | `Chore` | `chore` | Routine tasks, dependency updates, CI config |
| `spike.yml` | Spike | `Spike` | `spike` | Timeboxed technical investigation |

### 4.2 Template Anatomy

Every template follows this structure:

```yaml
name: Bug                                    # Display name in the "New issue" chooser
description: Report a confirmed or suspected bug.
type: Bug                                    # Sets the GitHub Issue Type on creation
projects: ["MCF-Technologie-GmbH/37"]       # Auto-adds to the Softwareentwicklung project

body:
  - type: markdown                           # Guidance callout
  - type: textarea (id: ...)                 # Template-specific fields (required/optional)
  - ...
  - type: dropdown (id: scope)              # Scope dropdown (populated from scopes.txt)
  - type: checkboxes (id: required-updates) # Required updates checklist
  - type: dropdown (id: template-type)      # Hidden Issue Type identifier (single option)
```

Key elements present in **every** template (except `spike.yml` and `documentation.yml` which exclude `required-updates`):

1. **Scope dropdown** — Populated automatically by the `update-template-scopes.mjs` script from `scopes.txt`.
2. **Required updates checkboxes** — Populated automatically by the `update-template-scopes.mjs` script from `required-updates.txt`.
3. **Issue Type dropdown** — A single-option dropdown that locks the expected type into the rendered body (used by the Worker for type detection).

### 4.3 Template Configuration

- **`config.yml`**: Contains `blank_issues_enabled: false`, forcing all issues to use a template.
- **Project board**: All templates include `projects: ["MCF-Technologie-GmbH/37"]` to automatically add every issue to the *Softwareentwicklung* master project board.

---

## 5. Cloudflare Worker (Automation Bot)

**Location:** [`cloudflare-worker/src/index.js`](cloudflare-worker/src/index.js) (Modular ES Modules, under `src/` folder)
**Deployment target:** Cloudflare Workers (`github-automation-bot`)
**GitHub App:** `mcf-automation-bot` (App ID: `3893672`)
**Subscribed events:** `issues`, `issue_comment`

### 5.1 Architecture

```text
GitHub Issues / Comments
        │
        ▼
  GitHub App webhook ──▶ Cloudflare Worker (src/index.js)
                                 │
                     ┌───────────┴───────────┐
                     │                       │
               projects repo          all other repos
                     │                       │
             enforce Project          ┌──────┴──────┐
                 type only            │             │
                                  Comment        Issue
                                  Command        Event
                                     │             │
                                  Process     - Enforce Type & Scope Immutability
                                  Slash       - Sync Scope field (Sidebar)
                                  Command     - Format Title
                                              - Sync Checklist
```

The Worker receives every `issues` and `issue_comment` webhook from the GitHub App. The codebase is modularized:
*   `src/index.js`: Handles webhook entrypoint, signature checks (HMAC-SHA256), and event routing.
*   `src/config.js`: Centralized constants and whitelists.
*   `src/utils/crypto.js`: App JWT authentication and crypto helpers.
*   `src/utils/text.js`: Title formatting and string parsing helpers.
*   `src/utils/checklist.js`: Checklist and labels syncing logic.
*   `src/services/github.js`: API client wrapper.
*   `src/handlers/`: Contains modular handlers for comments and issues logic.

On each request it:
1. Verifies the webhook signature.
2. Generates a GitHub App installation token.
3. Dynamically fetches organization issue types and fields via GraphQL.
4. Routes to the appropriate handler.

### 5.2 Dynamic Resolution

The Worker **does not hardcode any GraphQL Node IDs**. On every request, it queries:
- `organization.issueTypes` → builds a `Map<name, id>` of all issue types.
- `organization.issueFields` → resolves the `Scope` field ID and its option IDs dynamically.

This means zero-configuration: if types or fields are deleted and recreated in GitHub settings, the Worker adapts automatically.

### 5.3 Projects Repository Policy

For `MCF-Technologie-GmbH/projects`:
- **Only `Project` type is allowed.** If an issue is created with any other type, it is automatically corrected to `Project`.
- This ensures the `projects` repository remains a clean container for Epics only.

### 5.4 Codebase Repository Policy

For every other repository:
- **`Project` type is reserved and forbidden.** If an issue is created with type `Project`, it is closed automatically with an explanatory comment.
- **On creation:** The Worker detects which template was used (via `### Issue Type` in the body) and corrects the type if it doesn't match.
- **After creation:** If the type is changed manually, the Worker queries the `IssueTypeChangedEvent` timeline and reverts to the original type.

### 5.5 Title Auto-Prefixing

Developers write plain titles when creating issues. The Worker automatically rewrites the title using the **Conventional Commit format**:

```
type(scope): description
```

The mapping from Issue Type to commit prefix is:

| Issue Type | Prefix |
| :--- | :--- |
| Bug | `fix` |
| Feature | `feat` |
| Refactor | `refactor` |
| Test | `test` |
| Documentation | `docs` |
| Chore | `chore` |
| Spike | `spike` |

**Example:** A Bug issue with scope `ui` and title `correct modal validation` becomes:
```
fix(ui): correct modal validation
```

If the title already has the correct prefix, no change is made. If the scope is missing, the prefix is just `type: description`.

### 5.6 Scope Field Syncing & Immutability

The **Scope** is a critical metadata field. To enforce compliance, the Worker ensures the Scope is **immutable** after creation and stays synchronized between the issue title and the sidebar field:

1.  **Detección Inicial (On Creation):** The Worker parses the temporary `### Scope` block from the template's markdown body, updates the organization-level **Scope** single-select sidebar field, prefixes the title to `type(scope): description`, and deletes the `### Scope` block from the body.
2.  **Sincronización en Ediciones (On Body/Sidebar Edits):** Since the `### Scope` block is removed from the body on creation, the Worker falls back to extracting the scope from the issue title (`type(scope): description`). It continuously overwrites the sidebar single-select field with the scope found in the title, preventing manual drift or unauthorized sidebar changes.
3.  **Inmutabilidad del Scope en el Título (On Title Edits):** If a user attempts to edit the title to change the scope tag (e.g. changing `fix(ui): login` to `fix(api): login`), the Worker compares it to the previous title (`changes.title.from`). If the scope tags differ, the Worker automatically resets the title's scope prefix back to the original scope value (`ui`).
4.  **Continuous Sanitization:** If a user attempts to re-inject `### Scope` or `### Issue Type` blocks into the body during an edit, the Worker automatically strips them off during webhook processing.

### 5.7 Required Updates Checklist

On issue creation (`issues.opened`), the Developer's checkbox selections in the issue form (which GitHub initially renders in the Markdown body with `- [x]` if checked and `- [ ]` if unchecked) are intercepted by the Worker.

The Worker:
1. Reconstructs the **Required updates** checklist in the body to **only contain the items that the developer checked** in the form.
2. Initializes all these selected items as **unchecked** (`- [ ]`) in the final issue body, representing pending requirements.
3. Discards and removes all unchecked options from the checklist entirely.

For example, checking `Documentation` and `Tests` in the form will result in the following section in the final issue body:

```markdown
### Required updates
- [ ] Documentation
- [ ] Tests
```

Once initialized, the Worker manages the active checklist as follows:

| State | Behavior |
| :--- | :--- |
| `[ ]` unchecked | Adds `requires/<label>` label (e.g., `requires/docs`) |
| `[x]` checked | Removes the `requires/<label>` label |
| Active item deleted from body | Worker **restores** it (auto-healing) |
| Invalid item added manually | Worker **removes** it |

**Whitelist of valid items and their labels:**

| Checklist Item | Label |
| :--- | :--- |
| Documentation | `requires/docs` |
| Tests | `requires/tests` |
| Release notes | `requires/release-note` |
| Security review | `requires/security-review` |
| Migration | `requires/migration` |
| CI | `requires/ci` |
| Config | `requires/config` |

### 5.8 Comment Command Interface

Developers can modify the checklist by **commenting** on the issue with slash commands:

| Command | Effect |
| :--- | :--- |
| `/require <item>` | Adds `<item>` as pending (`- [ ]`) and adds its label |
| `/unrequire <item>` | Removes `<item>` from the checklist and removes its label |
| `/resolve <item>` or `/check <item>` | Marks `<item>` as checked (`- [x]`) and removes its label |
| `/unresolve <item>` or `/uncheck <item>` | Marks `<item>` as pending (`- [ ]`) and adds its label |

After processing a command:
1. The Worker reacts to the comment (✅ or ❌).
2. Updates the issue body and labels.
3. Deletes the comment to keep the timeline clean.

### 5.9 Template Type Detection

When an issue is opened, the Worker reads the `### Issue Type` section that GitHub injects into the body from the form's single-option dropdown:

```markdown
### Issue Type

Bug
```

The type name is matched against the dynamically loaded issue types. If the submitted type differs from the issue's actual GraphQL type, it is corrected. If no `### Issue Type` section is found (e.g., blank issue), the type is accepted as-is.

Once the template type is detected and corrected if necessary, the Worker **deletes** the temporary `### Issue Type` section from the issue description body. This keeps the description clean and focused on user-entered content, preventing clutter.

### 5.10 Issue Body Zoning & Reversion Policy

To prevent unauthorized manual edits to structural regions of an issue description while maintaining developer flexibility, the system divides the issue body into designated zones using HTML comments. The Cloudflare Worker intercepts edit events to enforce these zones.

#### The Three Zones
1. **Protected Section (`<!-- protected:start -->` / `<!-- protected:end -->`):**
   - Contains structural metadata and original user input fields (e.g. Current Behavior, Expected Behavior, Steps to Reproduce).
   - If a user attempts to edit this section after creation, the Worker automatically reverts it to the original text using the webhook's `changes.body.from` payload.
2. **Editable Section (`<!-- editable:start -->` / `<!-- editable:end -->`):**
   - Free-form technical notes, logs, workaround details, or code snippets.
   - Developers can freely modify this section without triggering reversion logic.
3. **Managed Section (`<!-- managed:start -->` / `<!-- managed:end -->`):**
   - Specifically wraps the **Required updates** checklist.
   - Checked and unchecked options here are handled by the Worker and comment slash command integrations (automatically syncing corresponding `requires/*` labels).

#### Reversion and Healing Flow
- **Body Change Validation:** When an `issues.edited` event is received, the Worker extracts the `protected` zone from both the previous body (`changes.body.from`) and the new body.
- **Reversion:** If a difference is detected in the `protected` section, the Worker overrides the edit in the new body, restoring the original content from the `from` payload.
- **Label & Checklist Healing:** The Worker then processes the `managed` section to ensure only valid taxonomy options from `required-updates.txt` exist, restoring any missing checklist items and keeping label states synchronized.

---

## 6. Automation Scripts

All scripts are ES modules (Node.js 22+). The project dependency is `yaml` for YAML parsing.

**npm shortcuts** (from `package.json`):
```bash
npm run validate          # node scripts/validate-taxonomy.mjs
npm run sync              # node scripts/sync-taxonomy.mjs
npm run sync:dry          # DRY_RUN=true node scripts/sync-taxonomy.mjs
```

### 6.1 validate-taxonomy.mjs

**Purpose:** Offline validation of all taxonomy YAML files. Run locally or in CI before merging.

**Checks performed:**
- Unique `key` and `name` for all issue types and fields.
- No `id` fields present (IDs are GitHub-managed).
- Valid `color` values (GRAY, BLUE, GREEN, YELLOW, ORANGE, RED, PINK, PURPLE).
- Valid `data_type` values (TEXT, SINGLE_SELECT, DATE, NUMBER, MULTI_SELECT).
- Select fields have non-empty `options` arrays with unique names.
- Non-select fields have no `options`.
- All `issue_type` references in `issue-type-fields.yml` exist in `issue-types.yml`.
- All `pinned_fields` references exist in `issue-fields.yml`.
- **Cross-validation:** `scopes.txt` and `issue-fields.yml` `scope` options are identical.
- **Cross-validation:** `required-updates.txt` and `cloudflare-worker/src/config.js` `REQUIRES_WHITELIST` keys are identical.

```bash
node scripts/validate-taxonomy.mjs
# ✅ Taxonomy validation passed (8 types, 7 fields, 8 mappings)
```

### 6.2 sync-taxonomy.mjs

**Purpose:** Reconcile the GitHub organization's actual state with the YAML definitions using the GraphQL API.

**Capabilities:**
- **Issue Types:** Creates missing types, updates name/description/color of existing types, reports drift for types that exist in GitHub but not in YAML.
- **Issue Fields:** Creates missing fields, updates name/data_type of existing fields, creates/updates field options for select types.
- **Pinned Fields:** Read-only drift detection. Reports exactly which fields need to be pinned or unpinned, with manual instructions pointing to the GitHub UI path.

**Drift reporting** is now descriptive — instead of just saying "drift", it tells you exactly what to change and where in the GitHub UI.

**Usage:**
```bash
# Dry run (report only, no changes)
export GITHUB_TOKEN=your_token
DRY_RUN=true node scripts/sync-taxonomy.mjs

# Apply changes
export GITHUB_TOKEN=your_token
node scripts/sync-taxonomy.mjs
```

### 6.3 update-template-scopes.mjs

**Purpose:** Acts as the central options injector. It:
1. Reads `taxonomy/scopes.txt` and updates the `options:` block under the `id: scope` dropdown in all 7 issue templates, as well as `taxonomy/issue-fields.yml`.
2. Reads `taxonomy/required-updates.txt` and updates the `options:` block under `id: required-updates` checkboxes in the 5 templates using it.

This ensures single sources of truth propagate automatically to templates and metadata files.

```bash
node scripts/update-template-scopes.mjs
# 🎉 Completed. Updated 5 issue templates.
```

---

## 7. End-to-End Data Flow

### 7.1 Taxonomy Change Flow

```text
Developer edits taxonomy/ YAML or scopes.txt
        │
        ▼
  Opens Pull Request
        │
        ├──▶ CI: validate-taxonomy.mjs ── checks integrity ── ✅ / ❌
        │
        ├──▶ CI: update-template-scopes.mjs ── syncs scope dropdowns
        │
        ├──▶ (Optional) DRY_RUN=true sync-taxonomy.mjs ── preview changes
        │
        ▼
  PR merged to main
        │
        ▼
  CI: sync-taxonomy.mjs ── GraphQL API ── creates/updates types, fields, options
        │
        ▼
  Pinned fields drift? ── Manual fix in GitHub UI (reported by script)
```

### 7.2 Issue Creation Flow

```text
Developer opens new issue using a template
        │
        ├── GitHub sets Issue Type from template's `type:` field
        ├── GitHub adds issue to Softwareentwicklung project (from `projects:`)
        ├── GitHub renders form fields into Markdown body
        │
        ▼
  GitHub App webhook (issues.opened) ──▶ Cloudflare Worker
        │
        ├── 1. Verify webhook signature
        ├── 2. Generate installation token (JWT + RSA)
        ├── 3. Fetch org issue types + fields (dynamic resolution)
        │
        ├── 4. Detect template type from body (### Issue Type section)
        │      └── Correct type via GraphQL if mismatch
        │
        ├── 5. Check if Project type in non-projects repo → close issue
        │
        ├── 6. Parse scope from body (### Scope section)
        │      └── Update organization-level Scope Issue Field via GraphQL
        │
        ├── 7. Format title: type(scope): description
        │      └── Update issue title via REST API
        │
        └── 8. Parse Required updates checklist
               ├── Heal invalid/missing items
               └── Sync requires/* labels
```

### 7.3 Issue Edit / Type Change Flow

```text
Developer manually changes issue type after creation
        │
        ▼
  GitHub App webhook (issues.typed) ──▶ Cloudflare Worker
        │
        ├── Query IssueTypeChangedEvent timeline
        ├── Find original type from first event
        └── Revert to original type via GraphQL
```

```text
Developer edits issue body
        │
        ▼
  GitHub App webhook (issues.edited) ──▶ Cloudflare Worker
        │
        ├── Re-parse scope → update Scope field if changed
        ├── Re-scan Required updates checklist
        │      ├── Restore deleted valid items
        │      ├── Remove invalid additions
        │      └── Re-sync requires/* labels
        └── Re-format title if scope changed
```

### 7.4 Comment Command Flow

```text
Developer comments: /require Tests
        │
        ▼
  GitHub App webhook (issue_comment.created) ──▶ Cloudflare Worker
        │
        ├── Parse slash command from comment body
        ├── Validate item against REQUIRES_WHITELIST
        ├── Update issue body (add/remove/check/uncheck item)
        ├── Sync requires/* labels accordingly
        ├── React to comment (✅ or ❌)
        └── Delete the comment
```

---

## 8. Infrastructure & Secrets

### GitHub App

| Setting | Value |
| :--- | :--- |
| App name | `mcf-automation-bot` |
| App ID | `3893672` |
| Repository permissions | Issues (write), Metadata (read) |
| Webhook events | Issues, Issue comment |
| Installation | All repositories in the organization |

### Cloudflare Worker

| Setting | Value |
| :--- | :--- |
| Worker name | `github-automation-bot` |
| Main file | `src/index.js` |
| Compatibility date | `2025-01-01` |

### Secrets (Cloudflare)

All secrets are stored in Cloudflare and **never** committed to the repository.

| Secret | Description |
| :--- | :--- |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret configured in the GitHub App |
| `GITHUB_APP_ID` | Numeric App ID |
| `GITHUB_PRIVATE_KEY` | RSA private key PEM from the GitHub App settings |

```bash
cd cloudflare-worker
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_PRIVATE_KEY
```

### Dependencies

| Tool | Version | Purpose |
| :--- | :--- | :--- |
| Node.js | 22+ | Run taxonomy scripts |
| npm `yaml` | ^2.7.0 | YAML parsing in scripts |
| `wrangler` CLI | latest | Cloudflare Worker deployment |
| GitHub PAT / App Token | — | `admin:org` or issue types/fields permissions for `sync-taxonomy.mjs` |

---

## 9. Known Limitations

| Limitation | Workaround |
| :--- | :--- |
| **Pinned Fields are read-only** in the GraphQL API | The sync script reports drift with exact instructions; manual changes in the GitHub UI are required |
| **Blank issues are disabled** (`config.yml`) | All issues must use a template. If a blank issue is somehow created, the Worker accepts it as-is (no `### Issue Type` section found) |
| **`IssueTypeChangedEvent` may not appear immediately** in the timeline | Extremely rare race condition — the Worker may fail to revert a type change if the webhook fires faster than GitHub records the timeline event |
| **Scope field sync depends on body parsing** | If a developer manually removes the `### Scope` section from the body, the field will not be updated |
| **Comment commands are case-insensitive** for item matching | Items are matched against `REQUIRES_WHITELIST` using case-insensitive comparison |
