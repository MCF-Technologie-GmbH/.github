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
