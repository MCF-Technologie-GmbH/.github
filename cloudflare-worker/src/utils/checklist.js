import { REQUIRES_WHITELIST } from "../config.js";

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

    return { checklist, startIndex, endIndex, heading: "## Required updates" };
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

export function healChecklist(newBody, oldBody) {
  const { checklist: newChecklist, startIndex, endIndex } = parseChecklist(newBody);
  if (startIndex === -1) return newBody;

  const { checklist: oldChecklist } = parseChecklist(oldBody);
  const validNames = Object.keys(REQUIRES_WHITELIST);

  const healedChecklist = [];
  const processedNames = new Set();

  for (const item of newChecklist) {
    const matchedName = validNames.find((v) => v.toLowerCase() === item.name.toLowerCase());
    if (matchedName) {
      if (!processedNames.has(matchedName)) {
        healedChecklist.push({ name: matchedName, checked: item.checked });
        processedNames.add(matchedName);
      }
    }
  }

  for (const item of oldChecklist) {
    const matchedName = validNames.find((v) => v.toLowerCase() === item.name.toLowerCase());
    if (matchedName && !processedNames.has(matchedName)) {
      healedChecklist.push({ name: matchedName, checked: item.checked });
      processedNames.add(matchedName);
    }
  }

  let checklistText = "\n";
  for (const item of healedChecklist) {
    checklistText += `- [${item.checked ? "x" : " "}] ${item.name}\n`;
  }

  return newBody.slice(0, startIndex) + checklistText + newBody.slice(endIndex);
}

export function cleanChecklistOnCreation(body) {
  const { checklist, startIndex, endIndex } = parseChecklist(body);
  if (startIndex === -1) return body;

  const validNames = Object.keys(REQUIRES_WHITELIST);
  const healedChecklist = [];
  const processedNames = new Set();

  for (const item of checklist) {
    const matchedName = validNames.find((v) => v.toLowerCase() === item.name.toLowerCase());
    if (matchedName && item.checked && !processedNames.has(matchedName)) {
      healedChecklist.push({ name: matchedName, checked: false });
      processedNames.add(matchedName);
    }
  }

  let checklistText = "\n";
  for (const item of healedChecklist) {
    checklistText += `- [${item.checked ? "x" : " "}] ${item.name}\n`;
  }

  return body.slice(0, startIndex) + checklistText + body.slice(endIndex);
}

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
