# MCF Technologie GmbH — `.github` Repository

This repository contains organization-wide GitHub configuration for **MCF Technologie GmbH**.

## Contents

| Path | Description |
|------|-------------|
| [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) | Issue form templates for all repositories |
| [`cloudflare-worker/`](cloudflare-worker/) | Cloudflare Worker that enforces issue type policies via GitHub App webhook |

## Issue Templates

Eight templates are available when creating issues across any repository in the organization. Each template automatically sets the correct Issue Type and adds the issue to the _Softwareentwicklung_ project board.

| Template | Issue Type | When to use |
|----------|------------|-------------|
| Bug Report | `Bug` | Something existing is not working as expected |
| Feature Request | `Feature` | Propose new functionality that does not yet exist |
| Task | `Task` | A concrete, well-defined unit of work |
| Research / Spike | `Task` | Investigation or spike before committing to implementation |
| Improvement | `Improvement` | Enhance existing functionality |
| DevOps | `DevOps` | Infrastructure, CI/CD, deployments, monitoring |
| Documentation | `Documentation` | Create, update, or restructure documentation |
| Maintenance | `Maintenance` | Tech debt, dependency upgrades, refactoring |

See [`cloudflare-worker/README.md`](cloudflare-worker/README.md) for how issue type policies are enforced.
