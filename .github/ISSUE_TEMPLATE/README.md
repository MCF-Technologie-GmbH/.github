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

Each template contains a `type: dropdown` field with label **Issue Type** and a **single option** equal to the type name (e.g., `Bug`). This is the only option for that template and is kept as creation metadata so the automation can confirm the issue type.

When a new issue is submitted, the Cloudflare Worker reads the rendered body section:

```markdown
### Issue Type

Bug
```

It compares the value against the organization issue types retrieved dynamically using GraphQL and corrects the issue type if they do not match. This means:

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
       description: This is the only option for this template. GitHub does not allow changing it here; it is kept as creation metadata for automation.
       options:
         - YourTypeName
     validations:
       required: true
   ```

4. Since the Cloudflare Worker dynamically resolves all types and fields by name, no code changes or ID configuration are needed in the worker when adding a new template. Just ensure the issue type name exists in `taxonomy/issue-types.yml` and is synchronized to the organization.
