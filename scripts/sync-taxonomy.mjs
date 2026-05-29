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

async function updateIssueField(id, desired) {
  const input = { id, name: desired.name };

  if (desired.description !== undefined) {
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

function diffPinnedFields(desiredFieldKeys, actualPinnedFields, fieldKeyToName) {
  const desiredNames = new Set(desiredFieldKeys.map((k) => fieldKeyToName[k]).filter(Boolean));
  const actualNames = new Set(actualPinnedFields.map((f) => f.name));

  const missing = [...desiredNames].filter((name) => !actualNames.has(name));
  const extra = [...actualNames].filter((name) => !desiredNames.has(name));

  return { missing, extra, hasDrift: missing.length > 0 || extra.length > 0 };
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

  const summary = { created: 0, updated: 0, drift: 0, unchanged: 0 };

  // --- Sync Issue Types ---
  console.log("\n━━━ Issue Types ━━━");

  const currentTypesByName = Object.fromEntries(initialTypes.map((t) => [t.name, t]));

  for (const desired of desiredTypes) {
    const actual = currentTypesByName[desired.name];

    if (!actual) {
      console.log(`  CREATE: ${desired.name} (${desired.color})`);
      if (!DRY_RUN) {
        const created = await createIssueType(desired);
        console.log(`    ✓ Created with id: ${created.id}`);
      }
      summary.created++;
    } else {
      const changes = diffIssueType(desired, actual);
      if (changes.length > 0) {
        console.log(`  UPDATE: ${desired.name}`);
        for (const c of changes) console.log(`    ${c}`);
        if (!DRY_RUN) {
          await updateIssueType(actual.id, desired);
          console.log(`    ✓ Updated`);
        }
        summary.updated++;
      } else {
        summary.unchanged++;
      }
    }
  }

  // Drift: types in GitHub but not in YAML
  const desiredTypeNames = new Set(desiredTypes.map((t) => t.name));
  for (const actual of initialTypes) {
    if (!desiredTypeNames.has(actual.name)) {
      console.log(`  DRIFT: '${actual.name}' exists in GitHub but not in YAML`);
      summary.drift++;
    }
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
      summary.created++;
    } else {
      const changes = diffIssueField(desired, actual);
      if (changes.length > 0) {
        console.log(`  UPDATE: ${desired.name}`);
        for (const c of changes) console.log(`    ${c}`);
        if (!DRY_RUN) {
          await updateIssueField(actual.id, desired);
          console.log(`    ✓ Updated`);
        }
        summary.updated++;
      } else {
        summary.unchanged++;
      }
    }
  }

  // Drift: fields in GitHub but not in YAML
  const desiredFieldNames = new Set(desiredFields.map((f) => f.name));
  for (const actual of initialFields) {
    if (!desiredFieldNames.has(actual.name)) {
      console.log(`  DRIFT: '${actual.name}' exists in GitHub but not in YAML`);
      summary.drift++;
    }
  }

  // --- Check pinned field mappings (read-only drift detection) ---
  console.log("\n━━━ Pinned Fields (read-only — drift detection only) ━━━");

  // fieldKeyToName: used for pinned-field drift detection (compare by name, not ID)
  const fieldKeyToName = Object.fromEntries(desiredFields.map((f) => [f.key, f.name]));
  const typeKeyToName = Object.fromEntries(desiredTypes.map((t) => [t.key, t.name]));

  for (const mapping of desiredMappings) {
    const typeName = typeKeyToName[mapping.issue_type];
    if (!typeName) continue;

    const actualType = currentTypesByName[typeName];
    if (!actualType) continue;

    const pinnedFields = actualType.pinnedFields || [];
    const desiredFieldKeys = mapping.pinned_fields || [];
    const { hasDrift, missing, extra } = diffPinnedFields(desiredFieldKeys, pinnedFields, fieldKeyToName);

    if (hasDrift) {
      console.log(`  DRIFT: ${typeName} pinned fields mismatch`);
      if (missing.length > 0) console.log(`    Missing in GitHub: ${missing.join(", ")}`);
      if (extra.length > 0) console.log(`    Extra in GitHub: ${extra.join(", ")}`);
      summary.drift++;
    }
  }

  // --- Summary ---
  console.log("\n━━━ Summary ━━━");
  console.log(`  Created:   ${summary.created}`);
  console.log(`  Updated:   ${summary.updated}`);
  console.log(`  Unchanged: ${summary.unchanged}`);
  console.log(`  Drift:     ${summary.drift}`);

  if (DRY_RUN && (summary.created > 0 || summary.updated > 0)) {
    console.log("\n⚠️  DRY RUN — no changes were applied. Run without DRY_RUN=true to apply.");
  }

  console.log("");
}

sync().catch((err) => {
  console.error(`\n💥 Sync failed: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
