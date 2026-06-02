# MCF Technologie GmbH — `.github` Repository

This repository contains organization-wide GitHub configuration for **MCF Technologie GmbH**.

## Contents

| Path                                                  | Description                                                                   |
|-------------------------------------------------------|-------------------------------------------------------------------------------|
| [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/)  | Issue form templates for all repositories                                     |
| [`taxonomy/`](taxonomy/)                              | YAML files defining the organization's issue types and fields                 |
| [`scripts/`](scripts/)                                | Automation scripts for validation and synchronization                         |
| [`cloudflare-worker/`](cloudflare-worker/)            | Cloudflare Worker that enforces issue type policies via GitHub App webhook    |

## Taxonomy as Code

The organization's metadata (Issue Types and Issue Fields) is managed declaratively via YAML files in the [`taxonomy/`](taxonomy/) directory.

- **`issue-types.yml`**: Defines names, descriptions, and colors for all available types.
- **`issue-fields.yml`**: Defines custom fields (Priority, Effort, etc.) and their data types (Single Select, Date, etc.).
- **`issue-type-fields.yml`**: Maps which fields should be pinned (visible by default) for each issue type.

### Synchronization Flow

1. **Change:** A developer modifies a YAML file in a Pull Request.
2. **Validate:** GitHub Actions runs [`validate-taxonomy.mjs`](scripts/validate-taxonomy.mjs) to ensure data integrity and reference consistency.
3. **Dry Run:** On PRs, the sync script can be run in `DRY_RUN=true` mode to report what changes would be applied.
4. **Apply:** Once merged to `main`, GitHub Actions runs [`sync-taxonomy.mjs`](scripts/sync-taxonomy.mjs) using the GraphQL API to reconcile the organization's state.

Note: While types and fields are created/updated automatically, **Pinned Fields** currently require manual assignment in the GitHub UI (drift is reported but not applied due to API limitations).

## Issue Templates

Eight templates are available when creating issues across any repository in the organization. Each template automatically sets the correct Issue Type and adds the issue to the _Softwareentwicklung_ project board.

| Template | Issue Type | When to use |
| -------- | ---------- | ----------- |
| Bug | `Bug` | Something existing is not working as expected |
| Feature | `Feature` | Propose new functionality that does not yet exist |
| Task | `Task` | A concrete, well-defined unit of work |
| Research / Spike | `Task` | Investigation or spike before committing to implementation |
| Improvement | `Improvement` | Enhance existing functionality |
| DevOps | `DevOps` | Infrastructure, CI/CD, deployments, monitoring |
| Documentation | `Documentation` | Create, update, or restructure documentation |
| Maintenance | `Maintenance` | Tech debt, dependency upgrades, refactoring |

See [`cloudflare-worker/README.md`](cloudflare-worker/README.md) for how issue type policies are enforced.
