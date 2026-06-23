#!/usr/bin/env node
/**
 * Taxonomy Validator
 *
 * Validates the taxonomy YAML files for consistency and correctness.
 * Exit code 0 = valid, 1 = validation errors found.
 */

import { readFileSync } from "fs";
import { parse } from "yaml";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAXONOMY_DIR = resolve(__dirname, "..", "taxonomy");

const VALID_COLORS = ["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE"];
const VALID_DATA_TYPES = ["TEXT", "SINGLE_SELECT", "DATE", "NUMBER", "MULTI_SELECT"];

function loadYaml(filename) {
  const path = resolve(TAXONOMY_DIR, filename);
  const content = readFileSync(path, "utf-8");
  return parse(content);
}

function validate() {
  const errors = [];

  // Load files
  let issueTypes, issueFields, issueTypeFields;
  try {
    issueTypes = loadYaml("issue-types.yml");
    issueFields = loadYaml("issue-fields.yml");
    issueTypeFields = loadYaml("issue-type-fields.yml");
  } catch (err) {
    console.error(`Failed to load taxonomy files: ${err.message}`);
    process.exit(1);
  }

  const types = issueTypes.issue_types || [];
  const fields = issueFields.issue_fields || [];
  const mappings = issueTypeFields.issue_type_fields || [];

  // --- Issue Types validation ---
  const typeKeys = new Set();
  const typeNames = new Set();

  for (const t of types) {
    if (!t.key) {
      errors.push(`Issue type missing 'key': ${JSON.stringify(t)}`);
      continue;
    }

    if (typeKeys.has(t.key)) {
      errors.push(`Duplicate issue type key: '${t.key}'`);
    }
    typeKeys.add(t.key);

    if (!t.name) {
      errors.push(`Issue type '${t.key}' missing 'name'`);
    } else if (typeNames.has(t.name)) {
      errors.push(`Duplicate issue type name: '${t.name}'`);
    } else {
      typeNames.add(t.name);
    }

    if (t.id) {
      errors.push(`Issue type '${t.key}' has an 'id' field — IDs are assigned by GitHub and must not be stored in YAML`);
    }

    if (t.color && !VALID_COLORS.includes(t.color)) {
      errors.push(`Issue type '${t.key}' has invalid color: '${t.color}' (valid: ${VALID_COLORS.join(", ")})`);
    }

    if (typeof t.is_enabled !== "boolean") {
      errors.push(`Issue type '${t.key}' missing or invalid 'is_enabled' (must be boolean)`);
    }
  }

  // --- Issue Fields validation ---
  const fieldKeys = new Set();
  const fieldNames = new Set();

  for (const f of fields) {
    if (!f.key) {
      errors.push(`Issue field missing 'key': ${JSON.stringify(f)}`);
      continue;
    }

    if (fieldKeys.has(f.key)) {
      errors.push(`Duplicate issue field key: '${f.key}'`);
    }
    fieldKeys.add(f.key);

    if (!f.name) {
      errors.push(`Issue field '${f.key}' missing 'name'`);
    } else if (fieldNames.has(f.name)) {
      errors.push(`Duplicate issue field name: '${f.name}'`);
    } else {
      fieldNames.add(f.name);
    }

    if (f.id) {
      errors.push(`Issue field '${f.key}' has an 'id' field — IDs are assigned by GitHub and must not be stored in YAML`);
    }

    if (!f.data_type) {
      errors.push(`Issue field '${f.key}' missing 'data_type'`);
    } else if (!VALID_DATA_TYPES.includes(f.data_type)) {
      errors.push(`Issue field '${f.key}' has invalid data_type: '${f.data_type}' (valid: ${VALID_DATA_TYPES.join(", ")})`);
    }

    // Single select must have options
    if (f.data_type === "SINGLE_SELECT" || f.data_type === "MULTI_SELECT") {
      if (!f.options || !Array.isArray(f.options) || f.options.length === 0) {
        errors.push(`Issue field '${f.key}' is ${f.data_type} but has no options`);
      } else {
        const optionNames = new Set();
        for (const opt of f.options) {
          if (!opt.name) {
            errors.push(`Issue field '${f.key}' has an option without a name`);
          } else if (optionNames.has(opt.name)) {
            errors.push(`Issue field '${f.key}' has duplicate option: '${opt.name}'`);
          } else {
            optionNames.add(opt.name);
          }
          if (opt.id) {
            errors.push(`Issue field '${f.key}' option '${opt.name}' has an 'id' field — IDs are assigned by GitHub and must not be stored in YAML`);
          }
          if (opt.color && !VALID_COLORS.includes(opt.color)) {
            errors.push(`Issue field '${f.key}' option '${opt.name}' has invalid color: '${opt.color}'`);
          }
        }
      }
    }

    // Non-select fields should not have options
    if (f.data_type && !["SINGLE_SELECT", "MULTI_SELECT"].includes(f.data_type)) {
      if (f.options && f.options.length > 0) {
        errors.push(`Issue field '${f.key}' is ${f.data_type} but has options defined (only select types support options)`);
      }
    }
  }

  // --- Scopes list validation ---
  try {
    const scopesPath = resolve(TAXONOMY_DIR, "scopes.txt");
    const scopesTxt = readFileSync(scopesPath, "utf-8")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));

    const scopeField = fields.find(f => f.key === "scope");
    if (!scopeField) {
      errors.push(`Missing 'scope' field in taxonomy/issue-fields.yml`);
    } else {
      const fieldScopeNames = (scopeField.options || []).map(o => o.name);

      // Compare both sets
      for (const s of scopesTxt) {
        if (!fieldScopeNames.includes(s)) {
          errors.push(`Scope '${s}' in taxonomy/scopes.txt is missing from 'scope' field options in taxonomy/issue-fields.yml`);
        }
      }
      for (const fName of fieldScopeNames) {
        if (!scopesTxt.includes(fName)) {
          errors.push(`Scope option '${fName}' in taxonomy/issue-fields.yml is missing from taxonomy/scopes.txt`);
        }
      }
    }
  } catch (err) {
    errors.push(`Failed to read/validate taxonomy/scopes.txt: ${err.message}`);
  }

  // --- Required updates list validation ---
  try {
    const requiredUpdatesPath = resolve(TAXONOMY_DIR, "required-updates.txt");
    const requiredUpdatesTxt = readFileSync(requiredUpdatesPath, "utf-8")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));

    const configPath = resolve(__dirname, "..", "cloudflare-worker", "src", "config.js");
    const configContent = readFileSync(configPath, "utf-8");

    // Extract KEYS from REQUIRES_WHITELIST in src/config.js
    const whitelistMatch = configContent.match(/const REQUIRES_WHITELIST = \{([\s\S]*?)\};/);
    if (!whitelistMatch) {
      errors.push(`Could not find REQUIRES_WHITELIST block in cloudflare-worker/src/config.js`);
    } else {
      const whitelistText = whitelistMatch[1];
      const whitelistKeys = [];
      const keyRegex = /"([^"]+)"\s*:/g;
      let match;
      while ((match = keyRegex.exec(whitelistText)) !== null) {
        whitelistKeys.push(match[1]);
      }

      // Cross check lists
      for (const item of requiredUpdatesTxt) {
        if (!whitelistKeys.includes(item)) {
          errors.push(`Required update option '${item}' in taxonomy/required-updates.txt is missing from REQUIRES_WHITELIST in cloudflare-worker/src/config.js`);
        }
      }
      for (const key of whitelistKeys) {
        if (!requiredUpdatesTxt.includes(key)) {
          errors.push(`Whitelist key '${key}' in cloudflare-worker/src/config.js is missing from taxonomy/required-updates.txt`);
        }
      }
    }
  } catch (err) {
    errors.push(`Failed to read/validate taxonomy/required-updates.txt: ${err.message}`);
  }

  // --- Issue Type Fields mapping validation ---
  const mappedTypes = new Set();

  for (const m of mappings) {
    if (!m.issue_type) {
      errors.push(`Mapping entry missing 'issue_type': ${JSON.stringify(m)}`);
      continue;
    }

    if (mappedTypes.has(m.issue_type)) {
      errors.push(`Duplicate mapping for issue type: '${m.issue_type}'`);
    }
    mappedTypes.add(m.issue_type);

    if (!typeKeys.has(m.issue_type)) {
      errors.push(`Mapping references unknown issue type: '${m.issue_type}'`);
    }

    const pinnedFields = m.pinned_fields || [];
    const seenFields = new Set();

    for (const fieldKey of pinnedFields) {
      if (!fieldKeys.has(fieldKey)) {
        errors.push(`Mapping for '${m.issue_type}' references unknown field: '${fieldKey}'`);
      }
      if (seenFields.has(fieldKey)) {
        errors.push(`Mapping for '${m.issue_type}' has duplicate field: '${fieldKey}'`);
      }
      seenFields.add(fieldKey);
    }
  }

  // Report results
  if (errors.length > 0) {
    console.error(`\n❌ Validation failed with ${errors.length} error(s):\n`);
    for (const err of errors) {
      console.error(`  • ${err}`);
    }
    console.error("");
    process.exit(1);
  }

  console.log(`✅ Taxonomy validation passed (${types.length} types, ${fields.length} fields, ${mappings.length} mappings)`);
  process.exit(0);
}

validate();
