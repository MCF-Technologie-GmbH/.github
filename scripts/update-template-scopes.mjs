#!/usr/bin/env node
/**
 * Update Template Scopes and Required Updates
 *
 * Reads taxonomy/scopes.txt and taxonomy/required-updates.txt and updates the
 * dropdown/checkbox options in all .github/ISSUE_TEMPLATE/*.yml files, as well
 * as taxonomy/issue-fields.yml.
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCOPES_FILE = resolve(__dirname, "..", "taxonomy", "scopes.txt");
const REQUIRED_UPDATES_FILE = resolve(__dirname, "..", "taxonomy", "required-updates.txt");
const TEMPLATES_DIR = resolve(__dirname, "..", ".github", "ISSUE_TEMPLATE");

try {
  // Read scopes
  const scopes = readFileSync(SCOPES_FILE, "utf-8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));

  console.log(`Loaded ${scopes.length} scopes from scopes.txt`);

  // Read required updates
  const requiredUpdates = readFileSync(REQUIRED_UPDATES_FILE, "utf-8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));

  console.log(`Loaded ${requiredUpdates.length} required updates from required-updates.txt`);

  // Format options blocks
  const optionsYaml = "      options:\n" + scopes.map(s => `        - ${s}`).join("\n");
  const requiredUpdatesYaml = "      options:\n" + requiredUpdates.map(r => `        - label: ${r}`).join("\n");

  // Read and update templates
  const files = readdirSync(TEMPLATES_DIR);
  let updatedCount = 0;

  for (const file of files) {
    if (!file.endsWith(".yml") || file === "config.yml") continue;

    const filePath = resolve(TEMPLATES_DIR, file);
    let content = readFileSync(filePath, "utf-8");
    let fileChanged = false;

    // 1. Update scope options block
    const regex = /(id:\s*scope\r?\n\s*attributes:\r?\n\s*label:\s*Scope\r?\n\s*description:[^\r\n]*\r?\n)\s*options:\r?\n(?:\s*-\s*[^\r\n]*\r?\n*)+/g;

    let scopeMatched = false;
    let updatedContent = content.replace(regex, (match, p1) => {
      scopeMatched = true;
      return p1 + optionsYaml + "\n";
    });

    if (scopeMatched && updatedContent !== content) {
      fileChanged = true;
    }

    // 2. Update required-updates checkboxes block (if present in template)
    const requiredUpdatesRegex = /(id:\s*required-updates\r?\n\s*attributes:\r?\n\s*label:\s*Required updates\r?\n\s*description:[^\r\n]*\r?\n)\s*options:\r?\n(?:\s*-\s*label:\s*[^\r\n]*\r?\n*)+/g;

    let requiredUpdatesMatched = false;
    const finalContent = updatedContent.replace(requiredUpdatesRegex, (match, p1) => {
      requiredUpdatesMatched = true;
      return p1 + requiredUpdatesYaml + "\n";
    });

    if (requiredUpdatesMatched && finalContent !== updatedContent) {
      fileChanged = true;
    }

    if (fileChanged) {
      writeFileSync(filePath, finalContent, "utf-8");
      console.log(`  ✓ Updated options in ${file}`);
      updatedCount++;
    } else {
      const parts = [];
      if (scopeMatched) parts.push("scope");
      if (requiredUpdatesMatched) parts.push("required updates");
      console.log(`  ✓ Options (${parts.join(", ")}) in ${file} are already up-to-date`);
    }
  }

  // Read and update taxonomy/issue-fields.yml
  const fieldsFilePath = resolve(__dirname, "..", "taxonomy", "issue-fields.yml");
  let fieldsContent = readFileSync(fieldsFilePath, "utf-8");

  // Matches the options block for the scope field in issue-fields.yml
  const fieldsRegex = /(\-\s*key:\s*scope\r?\n\s*name:\s*Scope\r?\n\s*data_type:\s*SINGLE_SELECT\r?\n\s*options:\r?\n)(?:\s*\-\s*name:\s*[^\r\n]*\r?\n\s*color:\s*[^\r\n]*\r?\n*)+/g;

  let fieldsMatched = false;
  const updatedFieldsContent = fieldsContent.replace(fieldsRegex, (match, p1) => {
    fieldsMatched = true;
    const fieldsOptionsYaml = scopes.map(s => `      - name: ${s}\n        color: GRAY`).join("\n") + "\n";
    return p1 + fieldsOptionsYaml;
  });

  if (fieldsMatched) {
    if (updatedFieldsContent !== fieldsContent) {
      writeFileSync(fieldsFilePath, updatedFieldsContent, "utf-8");
      console.log(`  ✓ Updated scope options in issue-fields.yml`);
    } else {
      console.log(`  ✓ Scope options in issue-fields.yml are already up-to-date`);
    }
  } else {
    console.warn(`  ⚠️ Could not find scope options block in issue-fields.yml`);
  }

  console.log(`\n🎉 Completed. Updated ${updatedCount} issue templates.`);
} catch (err) {
  console.error(`💥 Failed to update template scopes/updates: ${err.message}`);
  process.exit(1);
}
