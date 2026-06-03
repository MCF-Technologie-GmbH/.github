# Issue Taxonomy

This directory contains the declarative definition of the organization's issue metadata.

## Files

- **`issue-types.yml`**: The list of all issue types (Bug, Chore, Feature, etc.). Each entry must have a unique `key`, a `name`, a `color`, and an `isEnabled` flag.
- **`issue-fields.yml`**: Custom metadata fields. Supported data types: `TEXT`, `NUMBER`, `DATE`, `SINGLE_SELECT`, `MULTI_SELECT`. For select fields, `options` must be provided.
- **`issue-type-fields.yml`**: Defines the "Pinned Fields" for each type. These are the fields that appear in the sidebar by default when an issue of that type is selected.

## Modifying Taxonomy

1. Edit the relevant YAML file.
2. Run validation locally: `node scripts/validate-taxonomy.mjs`.
3. Create a Pull Request.
4. Once merged to `main`, the changes will be automatically synced to the GitHub organization.

**Note:** IDs are managed by GitHub. Never add `id:` fields to these files; they will be resolved dynamically by the sync script.
