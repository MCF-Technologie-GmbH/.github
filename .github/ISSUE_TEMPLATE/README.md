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

Each template sets the native GitHub issue form `type:` field and includes a required single-option **Issue Type** dropdown with the same value.

When a new issue is submitted, GitHub writes the dropdown value into the issue body:

```md
### Issue Type

Bug
```

It compares the value against the organization issue types retrieved dynamically using GraphQL and corrects the issue type if they do not match. This means:

- Users see the template issue type, but the dropdown only has the correct option.
- If a user changes the type after creation, the Worker **reverts** it using the `IssueTypeChangedEvent` timeline.

## Adding a New Template

1. Create a new `.yml` file in this directory following the same structure as an existing template.

2. Set the `type:` field in the YAML frontmatter to the intended issue type name (must match exactly what appears in the org's issue type list).

3. Add the single-option issue type dropdown to the form body:

   ```yaml
   - type: dropdown
     id: issue-type
     attributes:
       label: Issue Type
       description: This template only supports the YourTypeName issue type.
       options:
         - YourTypeName
     validations:
       required: true
   ```

4. Since the Cloudflare Worker dynamically resolves all types and fields by name, no code changes or ID configuration are needed in the worker when adding a new template. Just ensure the issue type name exists in `taxonomy/issue-types.yml` and is synchronized to the organization.
