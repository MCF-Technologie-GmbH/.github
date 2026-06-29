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
 * Extracts all contents for a repeated commented section.
 *
 * @param {string} body - The Markdown body text.
 * @param {string} name - The name of the section.
 * @returns {string[]} Section contents in document order.
 */
export function extractSections(body, name) {
  if (!body) return [];
  const regex = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`, "g");
  return [...String(body).matchAll(regex)].map((match) => match[1]);
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
 * Replaces all repeated commented sections with the provided contents.
 *
 * @param {string} body - The Markdown body text.
 * @param {string} name - The name of the section.
 * @param {string[]} newContents - Replacement contents in document order.
 * @returns {string} The modified Markdown body.
 */
export function replaceSections(body, name, newContents) {
  if (!body) return "";
  let index = 0;
  const regex = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`, "g");
  return String(body).replace(regex, () => {
    const replacement = newContents[index++];
    return `<!-- ${name}:start -->${replacement ?? ""}<!-- ${name}:end -->`;
  });
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
