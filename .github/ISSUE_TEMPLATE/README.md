# Issue Templates

Eight GitHub issue form templates are defined here for use across all repositories in the MCF Technologie GmbH organization.

## Template List

| File | Template Name | Issue Type | Title Prefix |
|------|--------------|------------|--------------|
| `bug.yml` | Bug Report | `Bug` | `[Bug]: ` |
| `feature.yml` | Feature Request | `Feature` | `[Feature]: ` |
| `task.yml` | Task | `Task` | `[Task]: ` |
| `spike.yml` | Research / Spike | `Task` | `[Spike]: ` |
| `improvement.yml` | Improvement | `Improvement` | `[Improvement]: ` |
| `devops.yml` | DevOps | `DevOps` | `[DevOps]: ` |
| `documentation.yml` | Documentation | `Documentation` | `[Docs]: ` |
| `maintenance.yml` | Maintenance | `Maintenance` | `[Maintenance]: ` |

> **Note:** The Research/Spike template uses the `Task` issue type because GitHub does not have a dedicated Spike type.

## How Template Detection Works

Each template contains a `type: dropdown` field with label **Issue Type** and a **single option** equal to the type name (e.g., `Bug`). Because there is only one option in the dropdown, GitHub's form UI does not allow users to change it.

When a new issue is submitted, the Cloudflare Worker reads the rendered body section:

```
### Issue Type

Bug
```

It compares the value against the expected type from `TEMPLATE_TYPE_IDS` in `worker.js` and corrects the issue type if they do not match. This means:

- Users **cannot** change the issue type before submitting (single-option dropdown).
- If a user changes the type after creation, the Worker **reverts** it using the `IssueTypeChangedEvent` timeline.

## Adding a New Template

1. Create a new `.yml` file in this directory following the same structure as an existing template.

2. Set the `type:` field in the YAML frontmatter to the intended issue type name (must match exactly what appears in the org's issue type list).

3. Add the **Issue Type dropdown** to the form body (copy from an existing template and change the option value):

   ```yaml
   - type: dropdown
     id: template-type
     attributes:
       label: Issue Type
       description: Identifies which issue template was used. Do not change this value.
       options:
         - YourTypeName
     validations:
       required: true
   ```

4. Add the new type to `TEMPLATE_TYPE_IDS` in `cloudflare-worker/worker.js`:

   ```js
   const TEMPLATE_TYPE_IDS = {
     // ... existing entries ...
     "YourTypeName": "IT_kwDOCAEFQs4...",  // get ID with the command below
   };
   ```

5. Get the GraphQL node ID for the new type:

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

6. Redeploy the worker: `cd cloudflare-worker && npx wrangler deploy`

## Updating Existing Type IDs

Issue type node IDs are stable and do not change unless the type is deleted and recreated. If IDs need to be refreshed, run the query above and update both `TEMPLATE_TYPE_IDS` and `PROJECT_ISSUE_TYPE_ID` in `cloudflare-worker/worker.js`.
