# Cloudflare Worker — GitHub Issue Type Enforcer

A Cloudflare Worker that receives GitHub App webhooks and enforces issue type policies across all repositories in the MCF Technologie GmbH organization.

## What it Does

### `MCF-Technologie-GmbH/projects` repository
- Only the `Project` issue type is allowed.
- Any issue created or changed to a different type is automatically corrected to `Project`.

### All other repositories
- `Project` is a reserved type and not allowed outside the `projects` repo. Issues with this type are closed automatically.
- **On creation:** the Worker detects which template was used (via the embedded `Issue Type` dropdown field) and corrects the type if it does not match.
- **After creation:** any type change is detected and reverted. The original type is read from the `IssueTypeChangedEvent` timeline, which means no metadata comments or external storage are needed.

## Architecture

```
GitHub Issues event
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
                                type change    opened / reopened
                                     │             │
                                  revert      detect template,
                               to original    correct type if
                               (timeline)        wrong
```

The entire implementation lives in a single file (`worker.js`, ~900 lines). It is split into clear logical sections:

| Section | Lines (approx.) | Description |
|---------|-----------------|-------------|
| Constants | ~60 | Org, repo names, type IDs |
| Entry point | ~100 | `fetch` handler, signature verification, routing |
| Policy functions | ~300 | Business logic for each enforcement rule |
| `GitHubClient` | ~150 | GraphQL + REST helpers |
| Auth helpers | ~80 | GitHub App JWT creation, installation token |
| Crypto utilities | ~200 | RSA key import, HMAC verification, base64 helpers |

> **Single file vs. multiple modules:** At ~900 lines, splitting is not necessary. Wrangler supports ES module imports if the file grows significantly — `auth.js` and `github.js` are the natural split points.

## Prerequisites

### GitHub App
- App ID: `3893672` (slug: `mcf-automation-bot`)
- Required **repository permissions:** Issues (write), Metadata (read)
- Required **webhook events:** Issues
- Webhook URL: your Cloudflare Worker URL
- Webhook secret: a random string you choose (used to verify payloads)
- Installed on: all repositories in the organization

### Cloudflare Worker
- Account with Workers enabled
- `wrangler` CLI (`npm install -g wrangler` or `npx wrangler`)

## Secrets

All secrets are stored in Cloudflare and never committed to the repository.

| Secret | Description |
|--------|-------------|
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

For `GITHUB_PRIVATE_KEY`, paste the full PEM (including `-----BEGIN RSA PRIVATE KEY-----` header/footer) when prompted.

## Deployment

```bash
cd cloudflare-worker
npx wrangler deploy
```

This publishes `worker.js` to Cloudflare and makes the webhook URL live.

## Issue Type IDs

Issue type node IDs are **stable GraphQL node IDs** specific to this organization. They are hardcoded in `worker.js` as constants.

### Current IDs

| Type | GraphQL Node ID |
|------|----------------|
| `Task` | `IT_kwDOCAEFQs4BKtmG` |
| `Bug` | `IT_kwDOCAEFQs4BKtmJ` |
| `Feature` | `IT_kwDOCAEFQs4BKtmM` |
| `Improvement` | `IT_kwDOCAEFQs4BpYBi` |
| `Research/Spike` | `IT_kwDOCAEFQs4CA6t8` |
| `Documentation` | `IT_kwDOCAEFQs4CA6uB` |
| `Maintenance` | `IT_kwDOCAEFQs4CA6uF` |
| `Project` | `IT_kwDOCAEFQs4CBH8t` |
| `DevOps` | `IT_kwDOCAEFQs4CBIei` |

### Refreshing IDs

IDs only change if a type is deleted and recreated. To fetch the current list:

```bash
gh api graphql \
  -H "GraphQL-Features: issue_types" \
  -f query='query {
    organization(login: "MCF-Technologie-GmbH") {
      issueTypes(first: 20) {
        nodes { id name }
      }
    }
  }'
```

Update `TEMPLATE_TYPE_IDS` and `PROJECT_ISSUE_TYPE_ID` in `worker.js`, then redeploy.

## Debugging

### Real-time logs

```bash
cd cloudflare-worker
npx wrangler tail
```

Every webhook the Worker processes is logged with the event, action, repo, issue number, and enforcement result.

### GitHub App webhook delivery logs

In the GitHub App settings → **Advanced** → **Recent Deliveries**, you can see every webhook delivery with the full request payload and the Worker's HTTP response. This is the first place to check if something is not triggering.

### Common issues

| Symptom | Likely cause |
|---------|--------------|
| Worker does nothing | Code changes were not redeployed (`npx wrangler deploy`) |
| `401 Invalid signature` in logs | `GITHUB_WEBHOOK_SECRET` does not match the value in the GitHub App settings |
| `500 Missing Cloudflare variable` | A required secret was not set (`wrangler secret put ...`) |
| Template type not detected | The issue was created without using a form template (blank issue) |
| Type reverted to wrong value | `IssueTypeChangedEvent` not yet in timeline (webhook fired too fast — extremely rare) |

## Template Type Detection

When an issue is opened, the Worker reads the `### Issue Type` section that GitHub injects into the body from the form's `type: dropdown` field:

```
### Issue Type

Bug
```

The type name is matched against `TEMPLATE_TYPE_IDS` to find the expected GraphQL ID. If the submitted type differs, it is corrected. If no `### Issue Type` section is found (e.g., blank issue), the type is accepted as-is.

See [`.github/ISSUE_TEMPLATE/README.md`](../.github/ISSUE_TEMPLATE/README.md) for how to add a new template type.
