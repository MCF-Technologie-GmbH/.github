# Automation Scripts

These scripts handle the validation and synchronization of the organization's issue taxonomy.

## Scripts

- **`validate-taxonomy.mjs`**: Ensures that the YAML files in `/taxonomy` are valid, have unique keys/names, and that all cross-references are correct. It also enforces the "No ID" policy.
- **`sync-taxonomy.mjs`**: The reconciler script. It compares the YAML definitions with the actual state in the GitHub Organization via GraphQL and applies necessary changes (Create/Update). It also detects and reports drift for Pinned Fields.

## Usage

### Local Validation

```bash
node scripts/validate-taxonomy.mjs
```

### Dry Run (Report differences without applying)

```bash
export GITHUB_TOKEN=your_token
DRY_RUN=true node scripts/sync-taxonomy.mjs
```

### Apply Changes

```bash
export GITHUB_TOKEN=your_token
node scripts/sync-taxonomy.mjs
```

## Requirements

- Node.js 22+
- A GitHub Personal Access Token (PAT) or App Token with `admin:org` (or specialized Issue Types/Fields) permissions.
