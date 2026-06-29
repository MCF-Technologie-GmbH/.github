# Issue Templates

Seven GitHub issue form templates are defined here for use across all repositories in the MCF Technologie GmbH organization.

## Template List

| File | Template Name | Issue Type | Commit Prefix | When to Use |
| ---- | ------------ | ---------- | ------------- | ----------- |
| `bug.yml` | Bug | `Bug` | `fix` | Unexpected error, defect, or incorrect behavior |
| `feature.yml` | Feature | `Feature` | `feat` | New functional or technical capability |
| `refactor.yml` | Refactor | `Refactor` | `refactor` | Internal code restructuring or debt reduction |
| `test.yml` | Test | `Test` | `test` | Adding, improving, or repairing test suites |
| `documentation.yml` | Documentation | `Documentation` | `docs` | Modifying docs, guides, or release notes |
| `chore.yml` | Chore | `Chore` | `chore` | Routine tasks, dependency updates, CI config, repo maintenance |
| `spike.yml` | Spike | `Spike` | `spike` | Timeboxed technical investigation |

## How Template Detection Works

Each template sets the native GitHub issue form `type:` field and includes a hidden HTML marker with the same value. The visible single-option **Issue Type** dropdown is intentionally not used, because it adds noise without giving users a real choice.

When a new issue is submitted, the Cloudflare Worker reads the hidden marker:

```html
<!-- issue-template-type: Bug -->
```

It compares the value against the organization issue types retrieved dynamically using GraphQL and corrects the issue type if they do not match. This means:

- Users do not see or edit the template issue type control during creation.
- If a user changes the type after creation, the Worker **reverts** it using the `IssueTypeChangedEvent` timeline.

## Adding a New Template

1. Create a new `.yml` file in this directory following the same structure as an existing template.

2. Set the `type:` field in the YAML frontmatter to the intended issue type name (must match exactly what appears in the org's issue type list).

3. Add the hidden issue template marker to the form body:

   ```yaml
   - type: markdown
     attributes:
       value: "<!-- issue-template-type: YourTypeName -->"
   ```

4. Since the Cloudflare Worker dynamically resolves all types and fields by name, no code changes or ID configuration are needed in the worker when adding a new template. Just ensure the issue type name exists in `taxonomy/issue-types.yml` and is synchronized to the organization.
