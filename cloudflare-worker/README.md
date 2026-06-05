# Cloudflare Worker — GitHub Issue Automation Bot

A Cloudflare Worker that receives GitHub App webhooks (`issues` and `issue_comment` events) and enforces issue type policies, synchronizes the `Scope` Issue Field, re-formats titles with Conventional Commit prefixes, tracks required updates, and processes slash commands in comments across all repositories in the MCF Technologie GmbH organization.

## What it Does

### 1. `MCF-Technologie-GmbH/projects` repository
- Only the `Project` issue type is allowed.
- Any issue created or changed to a different type is automatically corrected to `Project`.

### 2. All other repositories
- `Project` is a reserved type and not allowed outside the `projects` repo. Issues with this type are closed automatically.
- **Dynamic Issue Type Enforcement:**
  - **On creation:** the Worker detects which template was used (via the `### Issue Type` section in the body) and corrects the type if it does not match.
  - **After creation:** any type change is detected and reverted back to the original type using the `IssueTypeChangedEvent` timeline history.
- **Scope Field Syncing:**
  - When an issue is created or the body is edited, the Worker parses the `### Scope` section from the body and updates the organization-level single-select `Scope` Issue Field via GraphQL.
- **Title Auto-Formatting:**
  - The Worker automatically updates the issue title to match the Conventional Commit format: `type(scope): description`.
  - For example, if a Bug template is used with scope `ui` and title `correct modal validation`, the Worker rewrites the title to `fix(ui): correct modal validation`.
- **Required Updates Checklist & Label Syncing:**
  - The Worker manages the checklist under the `## Required updates` (or `### Required updates`) section in the issue body.
  - Sychronizes `requires/*` labels based ONLY on **pending** (unchecked, `[ ]`) checklist items. If an item is checked (`[x]`), its label is removed.
  - **Auto-healing:** If a developer manually edits the issue body and deletes valid checklist items, the Worker restores them. If they add invalid items (not in the whitelist), the Worker removes them.
- **Comment Slash Commands:**
  - Developers can modify checklist items by commenting on the issue:
    - `/require <item>`: Adds `<item>` as pending (`- [ ]`) and adds its label.
    - `/unrequire <item>`: Removes `<item>` from the checklist and removes its label.
    - `/resolve <item>` or `/check <item>`: Marks `<item>` as checked (`- [x]`) and removes its label.
    - `/unresolve <item>` or `/uncheck <item>`: Marks `<item>` as pending (`- [ ]`) and adds its label.
  - After processing a command successfully, the Worker reacts to the comment and deletes it to keep the timeline clean.

---

## Architecture

```text
GitHub Issues / Comments
        │
        ▼
  GitHub App webhook ──▶ Cloudflare Worker (worker.js)
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
                                  Process     - Enforce Type
                                  Slash       - Sync Scope field
                                  Command     - Format Title
                                              - Sync Checklist
```

The entire implementation lives in a single file (`worker.js`). It dynamically queries all Issue Types and organization Issue Fields via the GraphQL API on request startup.

---

## Prerequisites

### GitHub App
- App ID: `3893672` (slug: `mcf-automation-bot`)
- Required **repository permissions:** Issues (write), Metadata (read)
- Required **webhook events:** Issues, Issue comment
- Webhook URL: your Cloudflare Worker URL
- Webhook secret: a random string you choose (used to verify payloads)
- Installed on: all repositories in the organization

### Cloudflare Worker
- Account with Workers enabled
- `wrangler` CLI (`npm install -g wrangler` or `npx wrangler`)

---

## Secrets

All secrets are stored in Cloudflare and never committed to the repository.

| Secret | Description |
| ------ | ----------- |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret configured in the GitHub App settings |
| `GITHUB_APP_ID` | The numeric App ID (found on the GitHub App settings page) |
| `GITHUB_PRIVATE_KEY` | The RSA private key PEM generated in the GitHub App settings |

Set each secret with:
```bash
cd cloudflare-worker
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_PRIVATE_KEY
```

---

## Deployment

```bash
cd cloudflare-worker
npx wrangler deploy
```

---

## Dynamic Issue Type & Field Resolution

Unlike static implementations, this Worker **does not hardcode GraphQL Node IDs**. On startup, it queries the organization's current configurations:
- Fetching available issue types (`organization.issueTypes`) to build a dynamic map of names to IDs.
- Fetching available issue fields (`organization.issueFields`) to dynamically resolve the `fieldId` of the `Scope` field and its option IDs.

This ensures zero-configuration and prevents failures if issue types or options are deleted and recreated in organization settings.

---

## Debugging & Logs

### Real-time logs
```bash
cd cloudflare-worker
npx wrangler tail
```

### GitHub App webhook delivery logs

In the GitHub App settings → **Advanced** → **Recent Deliveries**, you can see every webhook delivery with the full request payload and the Worker's HTTP response. This is the first place to check if something is not triggering.

### Common issues

| Symptom | Likely cause |
| ------- | ------------ |
| Worker does nothing | Code changes were not redeployed (`npx wrangler deploy`) |
| `401 Invalid signature` in logs | `GITHUB_WEBHOOK_SECRET` does not match the value in the GitHub App settings |
| `500 Missing Cloudflare variable` | A required secret was not set (`wrangler secret put ...`) |
| Template type not detected | The issue was created without using a form template (blank issue) |
| Type reverted to wrong value | `IssueTypeChangedEvent` not yet in timeline (webhook fired too fast — extremely rare) |
| Title not formatted | The issue type is a planning type (like Project) or the template was not used |

---

## Template Type Detection

When an issue is opened, the Worker reads the `### Issue Type` section that GitHub injects into the body from the form's `type: dropdown` field:

```markdown
### Issue Type

Bug
```

The type name is matched against the organization's dynamically loaded issue types to find the expected GraphQL ID. If the submitted type differs, it is corrected. If no `### Issue Type` section is found (e.g., blank issue), the type is accepted as-is.
