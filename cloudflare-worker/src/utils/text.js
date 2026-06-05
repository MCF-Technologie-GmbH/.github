/**
 * Normalizes a repository full name (e.g. "Owner/Repo") by trimming and converting to lowercase.
 *
 * @param {string} repoFullName - The repository full name.
 * @returns {string} The normalized repository name.
 */
export function normalizeRepo(repoFullName) {
  return String(repoFullName || "").trim().toLowerCase();
}

/**
 * Extracts the content of a specific commented section in a Markdown body.
 * Sections are delimited by <!-- name:start --> and <!-- name:end --> comments.
 *
 * @param {string} body - The Markdown body text.
 * @param {string} name - The name of the section (e.g., "protected", "managed").
 * @returns {string|null} The content of the section, or null if not found.
 */
export function extractSection(body, name) {
  if (!body) return null;
  const regex = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`);
  const match = body.match(regex);
  return match ? match[1] : null;
}

/**
 * Replaces the content of a commented section inside a Markdown body with new content.
 * Keeps the comment tags intact.
 *
 * @param {string} body - The Markdown body text.
 * @param {string} name - The name of the section.
 * @param {string} newContent - The new text content to place between the comments.
 * @returns {string} The modified Markdown body.
 */
export function replaceSection(body, name, newContent) {
  if (!body) return "";
  const regex = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`);
  return body.replace(regex, `<!-- ${name}:start -->${newContent}<!-- ${name}:end -->`);
}

/**
 * Extracts the scope tag from an issue title formatted like "type(scope): description".
 * Returns the scope in lowercase.
 *
 * @param {string} title - The issue title.
 * @returns {string|null} The extracted scope name, or null if not found.
 */
export function extractScopeFromTitle(title) {
  if (!title) return null;
  // Matches "prefix(scope): " at the beginning of the title
  const match = title.match(/^[a-zA-Z0-9_-]+\(([^)]+)\)\s*:\s*/);
  return match ? match[1].trim().toLowerCase() : null;
}

/**
 * Parses the temporary "### Scope" section in the issue form body to detect the selected scope.
 *
 * @param {string} body - The Markdown body text.
 * @returns {string|null} The detected scope value, or null if not found.
 */
export function detectScopeFromBody(body) {
  if (!body) return null;
  // Matches "### Scope" header followed by two newlines and the scope value on the next line
  const match = body.match(/^### Scope\r?\n\r?\n([^\r\n]+)/m);
  if (!match) return null;
  return match[1].trim().toLowerCase();
}

/**
 * Re-formats an issue title to follow the Conventional Commits specification.
 * Converts the high-level Issue Type into a conventional prefix (e.g. Bug -> fix, Feature -> feat).
 *
 * @param {string} currentTitle - The current issue title.
 * @param {string} issueType - The resolved issue type (e.g. Bug, Feature).
 * @param {string|null} scope - The selected scope name.
 * @returns {string} The formatted Conventional Commit title.
 */
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
  // If the issue type doesn't have a mapped prefix, return the title as-is
  if (!commitType) return currentTitle;

  // Prefer the provided scope, fallback to extracting it from the title itself
  let resolvedScope = scope || extractScopeFromTitle(currentTitle);
  if (resolvedScope) {
    resolvedScope = resolvedScope.trim().toLowerCase();
    if (resolvedScope === "not set" || resolvedScope === "not_set" || resolvedScope === "none") {
      resolvedScope = null;
    }
  }
  const targetPrefix = resolvedScope ? `${commitType}(${resolvedScope}): ` : `${commitType}: `;

  // Strip existing conventional prefixes or bracket prefixes (e.g. "feat(ui): ", "[fix]: ", etc.)
  const cleanTitle = currentTitle
     .replace(/^[a-zA-Z0-9_-]+(?:\([^)]*\))?\s*:\s*/, "")
     .replace(/^\[[a-zA-Z0-9_-]+\]\s*:\s*/, "")
     .trim();

  return targetPrefix + cleanTitle;
}
