#!/usr/bin/env node
/**
 * Taxonomy Generator — Compiler
 *
 * Reads flat config files (scopes.txt and required-updates.txt) and automatically
 * injects the list of options into issue-fields.yml and the 7 GitHub Issue Form Templates.
 *
 * Usage:
 *   node scripts/generate-taxonomy.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { parseDocument } from "yaml";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const TAXONOMY_DIR = resolve(ROOT_DIR, "taxonomy");
const TEMPLATE_DIR = resolve(ROOT_DIR, ".github", "ISSUE_TEMPLATE");

try {
  console.log("⚙️  Running taxonomy autogeneration...");

  // 1. Load and parse scopes.txt
  const scopesPath = resolve(TAXONOMY_DIR, "scopes.txt");
  const scopes = readFileSync(scopesPath, "utf-8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));

  console.log(`   Loaded ${scopes.length} scopes from scopes.txt`);

  // 2. Load and parse required-updates.txt
  const requiredUpdatesPath = resolve(TAXONOMY_DIR, "required-updates.txt");
  const requiredUpdates = readFileSync(requiredUpdatesPath, "utf-8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));

  console.log(`   Loaded ${requiredUpdates.length} required updates checklists`);

  // 3. Inject scopes into taxonomy/issue-fields.yml
  const fieldsPath = resolve(TAXONOMY_DIR, "issue-fields.yml");
  const fieldsYaml = readFileSync(fieldsPath, "utf-8");
  const fieldsDoc = parseDocument(fieldsYaml);

  const issueFieldsNode = fieldsDoc.get("issue_fields");
  let priorityOptions = [];
  let effortOptions = [];
  if (issueFieldsNode) {
    const scopeFieldNode = issueFieldsNode.items.find(f => f.get("key") === "scope");
    if (scopeFieldNode) {
      const scopeOptions = [
        { name: "Not Set", color: "GRAY" },
        ...scopes.map(name => ({ name, color: "GRAY" }))
      ];
      scopeFieldNode.set("options", scopeOptions);
    }

    const priorityFieldNode = issueFieldsNode.items.find(f => f.get("key") === "priority");
    if (priorityFieldNode) {
      priorityOptions = priorityFieldNode.get("options")?.items?.map(opt => opt.get("name")) || [];
    }

    const effortFieldNode = issueFieldsNode.items.find(f => f.get("key") === "effort");
    if (effortFieldNode) {
      effortOptions = effortFieldNode.get("options")?.items?.map(opt => opt.get("name")) || [];
    }
  }
  writeFileSync(fieldsPath, fieldsDoc.toString(), "utf-8");
  console.log("   ✓ Updated taxonomy/issue-fields.yml");

  // 4. Dynamically list and filter GitHub Issue templates (.yml/.yaml excluding config.yml)
  const templates = readdirSync(TEMPLATE_DIR)
    .filter(file => (file.endsWith(".yml") || file.endsWith(".yaml")) && !file.startsWith("config."));

  for (const tmpl of templates) {
    const tmplPath = resolve(TEMPLATE_DIR, tmpl);
    const tmplYaml = readFileSync(tmplPath, "utf-8");
    const tmplDoc = parseDocument(tmplYaml);

    const bodyNode = tmplDoc.get("body");
    if (bodyNode) {
      // 4.1 Sync scopes in dropdown 'scope'
      const scopeInput = bodyNode.items.find(item => item.get("id") === "scope");
      if (scopeInput) {
        scopeInput.setIn(["attributes", "options"], scopes);
      }

      // 4.2 Sync priority and effort dropdowns from their issue field options
      const priorityInput = bodyNode.items.find(item => item.get("id") === "priority");
      if (priorityInput && priorityOptions.length > 0) {
        priorityInput.setIn(["attributes", "options"], priorityOptions);
      }

      const effortInput = bodyNode.items.find(item => item.get("id") === "effort");
      if (effortInput && effortOptions.length > 0) {
        effortInput.setIn(["attributes", "options"], effortOptions);
      }

      // 4.3 Sync checklist items in checkboxes 'required-updates'
      const requiredUpdatesInput = bodyNode.items.find(item => item.get("id") === "required-updates");
      if (requiredUpdatesInput) {
        const formattedCheckboxes = requiredUpdates.map(label => ({ label }));
        requiredUpdatesInput.setIn(["attributes", "options"], formattedCheckboxes);
      }
    }

    writeFileSync(tmplPath, tmplDoc.toString(), "utf-8");
    console.log(`   ✓ Updated .github/ISSUE_TEMPLATE/${tmpl}`);
  }

  console.log("\n✅ Taxonomy options successfully compiled and injected!\n");
  process.exit(0);
} catch (err) {
  console.error(`\n❌ Taxonomy generation failed: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
}
