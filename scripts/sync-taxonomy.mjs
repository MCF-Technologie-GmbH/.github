#!/usr/bin/env node
/**
 * Taxonomy Sync — Reconciler
 *
 * Reads desired state from taxonomy/*.yml and reconciles against the actual
 * state in GitHub using the GraphQL API.
 *
 * Operations:
 *   - CREATE: things in YAML but not in GitHub → created
 *   - UPDATE: things in both but with differences → updated
 *   - DRIFT:  things in GitHub but not in YAML → reported (not deleted)
 *
 * Environment variables:
 *   GITHUB_TOKEN — installation access token with org admin scope
 *   DRY_RUN     — set to "true" to only report changes without applying
 *
 * Usage:
 *   node scripts/sync-taxonomy.mjs
 *   DRY_RUN=true node scripts/sync-taxonomy.mjs
 */

import { readFileSync } from "fs";
import { parse } from "yaml";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAXONOMY_DIR = resolve(__dirname, "..", "taxonomy");

const ORGANIZATION = "MCF-Technologie-GmbH";
const GRAPHQL_URL = "https://api.github.com/graphql";

let orgNodeId; // resolved dynamically at startup via fetchOrgNodeId()
const GRAPHQL_FEATURES = "issue_types";
const API_VERSION = "2022-11-28";

const DRY_RUN = process.env.DRY_RUN === "true";
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error("ERROR: GITHUB_TOKEN environment variable is required");
  process.exit(1);
}

// --- YAML loading ---

function loadYaml(filename) {
  const path = resolve(TAXONOMY_DIR, filename);
  return parse(readFileSync(path, "utf-8"));
}

// --- GraphQL client ---

async function graphql(query, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "mcf-taxonomy-sync",
      "GraphQL-Features": GRAPHQL_FEATURES,
      "X-GitHub-Api-Version": API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
  }

  const body = JSON.parse(text);
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors, null, 2)}`);
  }

  return body.data;
}

// --- Fetch org node ID dynamically ---

async function fetchOrgNodeId() {
  const data = await graphql(`query { organization(login: "${ORGANIZATION}") { id } }`);
  return data.organization.id;
}

// --- Fetch current state from GitHub ---

async function fetchCurrentIssueTypes() {
  const data = await graphql(`query {
    organization(login: "${ORGANIZATION}") {
      issueTypes(first: 50) {
        nodes {
          id
          name
          description
          isEnabled
          color
          pinnedFields {
            ... on IssueFieldSingleSelect { id name }
            ... on IssueFieldText { id name }
            ... on IssueFieldNumber { id name }
            ... on IssueFieldDate { id name }
          }
        }
      }
    }
  }`);
  return data.organization.issueTypes.nodes;
}

async function fetchCurrentIssueFields() {
  const data = await graphql(`query {
    organization(login: "${ORGANIZATION}") {
      issueFields(first: 50) {
        nodes {
          ... on IssueFieldSingleSelect {
            id
            name
            options { id name color description }
          }
          ... on IssueFieldText { id name }
          ... on IssueFieldNumber { id name }
          ... on IssueFieldDate { id name }
        }
      }
    }
  }`);
  return data.organization.issueFields.nodes;
}

// --- Mutations ---

async function createIssueType(desired) {
  const data = await graphql(
    `mutation($input: CreateIssueTypeInput!) {
      createIssueType(input: $input) {
        issueType { id name }
      }
    }`,
    {
      input: {
        ownerId: orgNodeId,
        name: desired.name,
        description: desired.description || null,
        color: desired.color || "GRAY",
        isEnabled: desired.is_enabled !== false,
      },
    }
  );
  return data.createIssueType.issueType;
}

async function updateIssueType(id, desired) {
  await graphql(
    `mutation($input: UpdateIssueTypeInput!) {
      updateIssueType(input: $input) {
        issueType { id name }
      }
    }`,
    {
      input: {
        issueTypeId: id,
        name: desired.name,
        description: desired.description || null,
        color: desired.color || "GRAY",
        isEnabled: desired.is_enabled !== false,
      },
    }
  );
}

async function createIssueField(desired) {
  const input = {
    ownerId: orgNodeId,
    name: desired.name,
    dataType: desired.data_type,
  };

  if (desired.description) {
    input.description = desired.description;
  }

  if (["SINGLE_SELECT", "MULTI_SELECT"].includes(desired.data_type) && desired.options) {
    input.options = desired.options.map((opt, idx) => ({
      name: opt.name,
      color: opt.color || "GRAY",
      description: opt.description || null,
      priority: idx,
    }));
  }

  const data = await graphql(
    `mutation($input: CreateIssueFieldInput!) {
      createIssueField(input: $input) {
        issueField {
          ... on IssueFieldSingleSelect { id name }
          ... on IssueFieldText { id name }
          ... on IssueFieldNumber { id name }
          ... on IssueFieldDate { id name }
        }
      }
    }`,
    { input }
  );
  return data.createIssueField.issueField;
}

async function updateIssueField(id, desired, actual) {
  const input = { id };
  if (desired.name !== actual.name) {
    input.name = desired.name;
  }

  if (desired.description !== undefined) {
    input.description = desired.description;
  }

  if (["SINGLE_SELECT", "MULTI_SELECT"].includes(desired.data_type) && desired.options) {
    const actualOptionNames = new Set((actual.options || []).map((opt) => opt.name));
    const optionsToCreate = desired.options.filter((opt) => !actualOptionNames.has(opt.name));
    if (optionsToCreate.length > 0) {
      input.options = optionsToCreate.map((opt, idx) => ({
        name: opt.name,
        color: opt.color || "GRAY",
        description: opt.description || null,
        priority: actualOptionNames.size + idx,
      }));
    }
  }

  console.log("updateIssueField input:", JSON.stringify(input, null, 2));
  await graphql(
    `mutation($input: UpdateIssueFieldInput!) {
      updateIssueField(input: $input) {
        issueField {
          ... on IssueFieldSingleSelect { id name }
          ... on IssueFieldText { id name }
          ... on IssueFieldNumber { id name }
          ... on IssueFieldDate { id name }
        }
      }
    }`,
    { input }
  );
}

// --- Reconciliation logic ---

function diffIssueType(desired, actual) {
  const changes = [];
  if (desired.name !== actual.name) changes.push(`name: '${actual.name}' → '${desired.name}'`);
  if ((desired.description || null) !== (actual.description || null)) {
    changes.push(`description: '${actual.description}' → '${desired.description}'`);
  }
  if (desired.color && desired.color !== actual.color) {
    changes.push(`color: ${actual.color} → ${desired.color}`);
  }
  if (desired.is_enabled !== actual.isEnabled) {
    changes.push(`isEnabled: ${actual.isEnabled} → ${desired.is_enabled}`);
  }
  return changes;
}

function diffIssueField(desired, actual) {
  const changes = [];
  if (desired.name !== actual.name) changes.push(`name: '${actual.name}' → '${desired.name}'`);

  if (["SINGLE_SELECT", "MULTI_SELECT"].includes(desired.data_type) && desired.options && actual.options) {
    const desiredOpts = desired.options.map((o) => o.name).sort();
    const actualOpts = actual.options.map((o) => o.name).sort();
    if (JSON.stringify(desiredOpts) !== JSON.stringify(actualOpts)) {
      changes.push(`options: [${actualOpts.join(", ")}] → [${desiredOpts.join(", ")}]`);
    } else {
      // Check individual option properties
      for (const dOpt of desired.options) {
        const aOpt = actual.options.find((o) => o.name === dOpt.name);
        if (!aOpt) continue;
        if (dOpt.color && dOpt.color !== aOpt.color) {
          changes.push(`option '${dOpt.name}' color: ${aOpt.color} → ${dOpt.color}`);
        }
        if ((dOpt.description || null) !== (aOpt.description || null)) {
          changes.push(`option '${dOpt.name}' description changed`);
        }
      }
    }
  }

  return changes;
}

function getUnsupportedIssueFieldOptionChanges(desired, actual) {
  if (!["SINGLE_SELECT", "MULTI_SELECT"].includes(desired.data_type) || !desired.options || !actual.options) {
    return { removed: [], changed: [] };
  }

  const desiredOptionNames = new Set(desired.options.map((opt) => opt.name));
  const removed = actual.options
    .filter((opt) => !desiredOptionNames.has(opt.name))
    .map((opt) => opt.name);

  const changed = [];
  for (const desiredOption of desired.options) {
    const actualOption = actual.options.find((opt) => opt.name === desiredOption.name);
    if (!actualOption) continue;

    if (desiredOption.color && desiredOption.color !== actualOption.color) {
      changed.push(`${desiredOption.name} color`);
    }
    if ((desiredOption.description || null) !== (actualOption.description || null)) {
      changed.push(`${desiredOption.name} description`);
    }
  }

  return { removed, changed };
}

function diffPinnedFields(desiredFieldKeys, actualPinnedFields, fieldKeyToName) {
  const desiredNames = desiredFieldKeys.map((k) => fieldKeyToName[k]).filter(Boolean);
  const actualNames = actualPinnedFields.map((f) => f.name);

  const desiredSet = new Set(desiredNames);
  const actualSet = new Set(actualNames);

  const missing = desiredNames.filter((name) => !actualSet.has(name));
  const extra = actualNames.filter((name) => !desiredSet.has(name));

  return { 
    missing, 
    extra, 
    hasDrift: missing.length > 0 || extra.length > 0,
    actualNames,
    desiredNames
  };
}

// --- Main sync ---

async function sync() {
  console.log(`\n🔄 Taxonomy Sync — ${DRY_RUN ? "DRY RUN" : "APPLY"} mode\n`);
  console.log(`Organization: ${ORGANIZATION}`);

  // Load desired state
  const desiredTypes = loadYaml("issue-types.yml").issue_types || [];
  const desiredFields = loadYaml("issue-fields.yml").issue_fields || [];
  const desiredMappings = loadYaml("issue-type-fields.yml").issue_type_fields || [];

  // Resolve org node ID (needed for create mutations)
  orgNodeId = await fetchOrgNodeId();
  console.log(`Org Node ID:  ${orgNodeId} (resolved)\n`);

  // Fetch current state
  console.log("📡 Fetching current state from GitHub...");
  const initialTypes = await fetchCurrentIssueTypes();
  const initialFields = await fetchCurrentIssueFields();

  console.log(`   Found ${initialTypes.length} issue types, ${initialFields.length} issue fields\n`);

  const summary = {
    types: { created: 0, updated: 0, unchanged: 0, drift: 0 },
    fields: { created: 0, updated: 0, unchanged: 0, drift: 0 },
    pinned: { match: 0, drift: 0 }
  };

  // --- Sync Issue Types ---
  console.log("━━━ Issue Types ━━━");

  const currentTypesByName = Object.fromEntries(initialTypes.map((t) => [t.name, t]));

  for (const desired of desiredTypes) {
    const actual = currentTypesByName[desired.name];

    if (!actual) {
      console.log(`  CREATE: ${desired.name} (${desired.color})`);
      if (!DRY_RUN) {
        const created = await createIssueType(desired);
        console.log(`    ✓ Created with id: ${created.id}`);
      }
      summary.types.created++;
    } else {
      const changes = diffIssueType(desired, actual);
      if (changes.length > 0) {
        console.log(`  UPDATE: ${desired.name}`);
        for (const c of changes) console.log(`    ${c}`);
        if (!DRY_RUN) {
          await updateIssueType(actual.id, desired);
          console.log(`    ✓ Updated`);
        }
        summary.types.updated++;
      } else {
        summary.types.unchanged++;
      }
    }
  }

  // Drift: types in GitHub but not in YAML
  const desiredTypeNames = new Set(desiredTypes.map((t) => t.name));
  for (const actual of initialTypes) {
    if (!desiredTypeNames.has(actual.name)) {
      console.log(`  DRIFT: Issue type '${actual.name}' exists in GitHub but has no entry in taxonomy/issue-types.yml.`);
      console.log(`    → Action required: either add '${actual.name}' to taxonomy/issue-types.yml (to manage it as code)`);
      console.log(`      or disable it manually in GitHub:`);
      console.log(`      Organization Settings → Issue types → '${actual.name}' → Disable / Delete`);
      summary.types.drift++;
    }
  }

  if (summary.types.created === 0 && summary.types.updated === 0 && summary.types.drift === 0) {
    console.log("  ✓ All issue types are in sync with taxonomy");
  }

  // --- Sync Issue Fields ---
  console.log("\n━━━ Issue Fields ━━━");

  const currentFieldsByName = Object.fromEntries(initialFields.map((f) => [f.name, f]));

  for (const desired of desiredFields) {
    const actual = currentFieldsByName[desired.name];

    if (!actual) {
      console.log(`  CREATE: ${desired.name} (${desired.data_type})`);
      if (!DRY_RUN) {
        const created = await createIssueField(desired);
        console.log(`    ✓ Created with id: ${created.id}`);
      }
      summary.fields.created++;
    } else {
      const changes = diffIssueField(desired, actual);
      if (changes.length > 0) {
        const unsupportedOptionChanges = getUnsupportedIssueFieldOptionChanges(desired, actual);
        const hasUnsupportedOptionChanges =
          unsupportedOptionChanges.removed.length > 0 || unsupportedOptionChanges.changed.length > 0;

        if (hasUnsupportedOptionChanges) {
          console.log(`  DRIFT: ${desired.name}`);
          for (const c of changes) console.log(`    ${c}`);
          console.log("    → Manual action required in GitHub:");
          console.log(`      Organization Settings → Issue fields → '${desired.name}' → Edit options`);
          if (unsupportedOptionChanges.removed.length > 0) {
            console.log(`    → Options to DELETE: ${unsupportedOptionChanges.removed.map((opt) => `'${opt}'`).join(", ")}`);
          }
          if (unsupportedOptionChanges.changed.length > 0) {
            console.log(`    → Option properties to UPDATE: ${unsupportedOptionChanges.changed.join(", ")}`);
          }
          summary.fields.drift++;
          continue;
        }

        console.log(`  UPDATE: ${desired.name}`);
        for (const c of changes) console.log(`    ${c}`);
        if (!DRY_RUN) {
          await updateIssueField(actual.id, desired, actual);
          console.log(`    ✓ Updated`);
        }
        summary.fields.updated++;
      } else {
        summary.fields.unchanged++;
      }
    }
  }

  // Drift: fields in GitHub but not in YAML
  const desiredFieldNames = new Set(desiredFields.map((f) => f.name));
  for (const actual of initialFields) {
    if (!desiredFieldNames.has(actual.name)) {
      console.log(`  DRIFT: Issue field '${actual.name}' exists in GitHub but has no entry in taxonomy/issue-fields.yml.`);
      console.log(`    → Action required: either add '${actual.name}' to taxonomy/issue-fields.yml (to manage it as code)`);
      console.log(`      or delete it manually in GitHub:`);
      console.log(`      Organization Settings → Issue fields → '${actual.name}' → Delete`);
      summary.fields.drift++;
    }
  }

  if (summary.fields.created === 0 && summary.fields.updated === 0 && summary.fields.drift === 0) {
    console.log("  ✓ All issue fields are in sync with taxonomy");
  }

  // --- Check pinned field mappings (read-only drift detection) ---
  console.log("\n━━━ Pinned Fields (drift detection) ━━━");

  // fieldKeyToName: used for pinned-field drift detection (compare by name, not ID)
  const fieldKeyToName = Object.fromEntries(desiredFields.map((f) => [f.key, f.name]));
  const typeKeyToName = Object.fromEntries(desiredTypes.map((t) => [t.key, t.name]));

  let totalPinnedDrift = 0;
  for (const mapping of desiredMappings) {
    const typeName = typeKeyToName[mapping.issue_type];
    if (!typeName) continue;

    const actualType = currentTypesByName[typeName];
    if (!actualType) {
      console.log(`  SKIP: ${typeName} mapping (type does not exist in GitHub yet)`);
      continue;
    }

    const pinnedFields = actualType.pinnedFields || [];
    const desiredFieldKeys = mapping.pinned_fields || [];
    const { hasDrift, missing, extra, actualNames, desiredNames } = diffPinnedFields(desiredFieldKeys, pinnedFields, fieldKeyToName);

    if (hasDrift) {
      console.log(`  DRIFT: Pinned fields for issue type '${typeName}' do not match taxonomy/issue-type-fields.yml.`);
      console.log(`    → Manual action required in GitHub:`);
      console.log(`      Organization Settings → Issue types → '${typeName}' → Manage pinned fields`);
      if (missing.length > 0) {
        console.log(`    → Fields to PIN (add to sidebar): ${missing.map((f) => `'${f}'`).join(", ")}`);
      }
      if (extra.length > 0) {
        console.log(`    → Fields to UNPIN (remove from sidebar): ${extra.map((f) => `'${f}'`).join(", ")}`);
      }
      summary.pinned.drift++;
      totalPinnedDrift++;
    } else {
      summary.pinned.match++;
    }
  }

  if (totalPinnedDrift === 0) {
    console.log("  ✓ All pinned fields are in sync with taxonomy");
  }

  // --- Summary ---
  console.log("\n━━━ Summary ━━━");
  console.log("  Issue Types:");
  console.log(`    Created:   ${summary.types.created}`);
  console.log(`    Updated:   ${summary.types.updated}`);
  console.log(`    Unchanged: ${summary.types.unchanged}`);
  console.log(`    Drift:     ${summary.types.drift}`);

  console.log("\n  Issue Fields:");
  console.log(`    Created:   ${summary.fields.created}`);
  console.log(`    Updated:   ${summary.fields.updated}`);
  console.log(`    Unchanged: ${summary.fields.unchanged}`);
  console.log(`    Drift:     ${summary.fields.drift}`);

  console.log("\n  Pinned Fields (manual sync required):");
  console.log(`    In sync:   ${summary.pinned.match}`);
  console.log(`    Drift:     ${summary.pinned.drift}`);

  const totalActions = summary.types.created + summary.types.updated + summary.fields.created + summary.fields.updated;

  if (DRY_RUN && totalActions > 0) {
    console.log("\n⚠️  DRY RUN — no changes were applied. Run without DRY_RUN=true to apply.");
  }

  console.log("");
}

sync().catch((err) => {
  console.error(`\n💥 Sync failed: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
