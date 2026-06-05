export function normalizeRepo(repoFullName) {
  return String(repoFullName || "").trim().toLowerCase();
}

export function extractSection(body, name) {
  if (!body) return null;
  const regex = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`);
  const match = body.match(regex);
  return match ? match[1] : null;
}

export function replaceSection(body, name, newContent) {
  if (!body) return "";
  const regex = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`);
  return body.replace(regex, `<!-- ${name}:start -->${newContent}<!-- ${name}:end -->`);
}

export function extractScopeFromTitle(title) {
  if (!title) return null;
  const match = title.match(/^[a-zA-Z0-9_-]+\(([^)]+)\)\s*:\s*/);
  return match ? match[1].trim().toLowerCase() : null;
}

export function detectScopeFromBody(body) {
  if (!body) return null;
  const match = body.match(/^### Scope\r?\n\r?\n([^\r\n]+)/m);
  if (!match) return null;
  return match[1].trim().toLowerCase();
}

export function formatTitle(currentTitle, issueType, scope) {
  const typePrefixMap = {
    "Bug": "fix",
    "Feature": "feat",
    "Refactor": "refactor",
    "Test": "test",
    "Documentation": "docs",
    "Chore": "chore",
    "Spike": "spike",
  };

  const commitType = typePrefixMap[issueType];
  if (!commitType) return currentTitle;

  const resolvedScope = scope || extractScopeFromTitle(currentTitle);
  const targetPrefix = resolvedScope ? `${commitType}(${resolvedScope}): ` : `${commitType}: `;

  const cleanTitle = currentTitle
     .replace(/^[a-zA-Z0-9_-]+(?:\([^)]*\))?\s*:\s*/, "")
     .replace(/^\[[a-zA-Z0-9_-]+\]\s*:\s*/, "")
     .trim();

  return targetPrefix + cleanTitle;
}
