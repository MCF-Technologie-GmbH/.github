import { REQUIRES_WHITELIST } from "../config.js";

/**
 * Parses the "Required updates" checklist from the issue body.
 * It first searches within the managed HTML comments (`<!-- managed:start -->` and `<!-- managed:end -->`).
 * If not found, it falls back to parsing the checklist under the heading matching "# Required updates" for backwards compatibility.
 *
 * @param {string} body - The issue description body.
 * @returns {object} An object containing:
 *   - {array} checklist - List of items parsed (e.g. [{ checked: false, name: "Tests", rawLine: "- [ ] Tests" }])
 *   - {number} startIndex - Character index where the checklist items start in the body
 *   - {number} endIndex - Character index where the checklist items end in the body
 *   - {string} heading - The header text used (e.g. "### Required updates")
 */
export function parseChecklist(body) {
  if (!body) return { checklist: [], startIndex: -1, endIndex: -1 };

  // First try to parse inside the <!-- managed:start --> and <!-- managed:end --> block
  const regex = /<!-- managed:start -->([\s\S]*?)<!-- managed:end -->/;
  const match = body.match(regex);
  
  if (match) {
    const checklistText = match[1];
    const startIndex = match.index + "<!-- managed:start -->".length;
    const endIndex = match.index + match[0].length - "<!-- managed:end -->".length;

    const checklist = [];
    const itemRegex = /-\s*\[([ xX])\]\s*([^\r\n]+)/g;
    let itemMatch;
    while ((itemMatch = itemRegex.exec(checklistText)) !== null) {
      const checked = itemMatch[1].toLowerCase() === "x";
      const name = itemMatch[2].trim();
      checklist.push({ checked, name, rawLine: itemMatch[0] });
    }

    return { checklist, startIndex, endIndex, heading: "### Required updates" };
  }

  // Fallback to old heading-based parsing for backward compatibility
  const headingMatch = body.match(/(?:\r?\n|^)(#+\s*Required updates)\r?\n/i);
  if (!headingMatch) return { checklist: [], startIndex: -1, endIndex: -1 };

  const heading = headingMatch[1];
  const headingIndex = body.indexOf(heading);
  const startIndex = headingIndex + heading.length;

  const remainingText = body.slice(startIndex);
  const nextSectionMatch = remainingText.match(/(?:\r?\n|^)(#+\s+[^\r\n]+)/);
  const checklistSectionLength = nextSectionMatch ? nextSectionMatch.index : remainingText.length;
  const checklistText = remainingText.slice(0, checklistSectionLength);

  const checklist = [];
  const itemRegex = /-\s*\[([ xX])\]\s*([^\r\n]+)/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(checklistText)) !== null) {
    const checked = itemMatch[1].toLowerCase() === "x";
    const name = itemMatch[2].trim();
    checklist.push({ checked, name, rawLine: itemMatch[0] });
  }

  const endIndex = startIndex + checklistSectionLength;
  return { checklist, startIndex, endIndex, heading };
}

/**
 * Validates, restores, and heals the checklist block when an issue body is edited.
 * It ensures:
 * 1. Only items from the whitelist (REQUIRES_WHITELIST) are kept.
 * 2. Whitelisted items that were present in the old body but deleted in the new body are restored.
 * 3. Case-insensitivity in item names is corrected to match the whitelist casing.
 *
 * @param {string} newBody - The newly edited issue description body.
 * @param {string} oldBody - The previous issue description body (used for restoration).
 * @returns {string} The healed issue description body.
 */
export function healChecklist(newBody, oldBody) {
  const { checklist: newChecklist, startIndex, endIndex } = parseChecklist(newBody);
  if (startIndex === -1) return newBody;

  const { checklist: oldChecklist } = parseChecklist(oldBody);
  const validNames = Object.keys(REQUIRES_WHITELIST);

  const healedChecklist = [];
  const processedNames = new Set();

  // 1. Process items currently in the edited body. Keep them if they are in the whitelist.
  for (const item of newChecklist) {
    const matchedName = validNames.find((v) => v.toLowerCase() === item.name.toLowerCase());
    if (matchedName) {
      if (!processedNames.has(matchedName)) {
        healedChecklist.push({ name: matchedName, checked: item.checked });
        processedNames.add(matchedName);
      }
    }
  }

  // 2. Proactively restore whitelisted items that were deleted in the edit.
  for (const item of oldChecklist) {
    const matchedName = validNames.find((v) => v.toLowerCase() === item.name.toLowerCase());
    if (matchedName && !processedNames.has(matchedName)) {
      healedChecklist.push({ name: matchedName, checked: item.checked });
      processedNames.add(matchedName);
    }
  }

  if (healedChecklist.length === 0) {
    return newBody.slice(0, startIndex) + "\n_No response_\n" + newBody.slice(endIndex);
  }

  let checklistText = "\n";
  for (const item of healedChecklist) {
    checklistText += `- [${item.checked ? "x" : " "}] ${item.name}\n`;
  }

  return newBody.slice(0, startIndex) + checklistText + newBody.slice(endIndex);
}

/**
 * Sanitizes the checklist when an issue is created.
 * Extracts items checked in the initial issue form template and lists them in the body
 * as unchecked (`- [ ]`) requirements. All other whitelisted items are removed.
 *
 * @param {string} body - The raw issue description body on creation.
 * @returns {string} The cleaned body containing only the active, pending checklist.
 */
export function cleanChecklistOnCreation(body) {
  const { checklist, startIndex, endIndex } = parseChecklist(body);
  if (startIndex === -1) return body;

  const validNames = Object.keys(REQUIRES_WHITELIST);
  const healedChecklist = [];
  const processedNames = new Set();

  // Keep only whitelisted items that the user checked in the form template,
  // but reset their status to unchecked [ ] (pending developer action).
  for (const item of checklist) {
    const matchedName = validNames.find((v) => v.toLowerCase() === item.name.toLowerCase());
    if (matchedName && item.checked && !processedNames.has(matchedName)) {
      healedChecklist.push({ name: matchedName, checked: false });
      processedNames.add(matchedName);
    }
  }

  if (healedChecklist.length === 0) {
    return body.slice(0, startIndex) + "\n_No response_\n" + body.slice(endIndex);
  }

  let checklistText = "\n";
  for (const item of healedChecklist) {
    checklistText += `- [${item.checked ? "x" : " "}] ${item.name}\n`;
  }

  return body.slice(0, startIndex) + checklistText + body.slice(endIndex);
}

/**
 * Determines which `requires/*` labels should be applied to the issue
 * based on pending (unchecked) checklist items.
 *
 * @param {array} checklist - List of parsed checklist items.
 * @returns {array} A list of labels to set on the issue (e.g. ["requires/docs", "requires/tests"]).
 */
export function getRequiresLabelsForChecklist(checklist) {
  const desiredLabels = [];
  for (const item of checklist) {
    if (!item.checked) {
      const label = REQUIRES_WHITELIST[item.name];
      if (label) desiredLabels.push(label);
    }
  }
  return desiredLabels;
}
