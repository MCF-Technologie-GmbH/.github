/**
 * Cloudflare Worker - MCF GitHub Issue Type Enforcement
 *
 * This Worker is triggered by the GitHub App webhook and enforces these rules:
 *
 * 1. Repository: MCF-Technologie-GmbH/projects
 *    - Only Issue Type `Project` is allowed. Any other type is corrected automatically.
 *
 * 2. Every other repository:
 *    - Issue Type `Project` is reserved and not allowed.
 *    - If an issue is created as `Project`, it is closed automatically.
 *    - On creation, the issue type is validated against the template detected from
 *      the Issue Type dropdown field embedded in each template (not changeable during
 *      form filling — the dropdown has a single option). If wrong, it is corrected.
 *    - If the Issue Type is changed after creation, the Worker queries the
 *      IssueTypeChangedEvent timeline to restore the original type.
 *
 * Required Cloudflare secrets / variables:
 *   GITHUB_WEBHOOK_SECRET  Same value configured as the GitHub App webhook secret
 *   GITHUB_APP_ID          Numeric GitHub App ID
 *   GITHUB_PRIVATE_KEY     GitHub App private key PEM
 *
 * Required GitHub App repository permissions:
 *   Metadata: read
 *   Issues: write
 *
 * Required GitHub App webhook event:
 *   Issues
 */

const ORGANIZATION = "MCF-Technologie-GmbH";
const PROJECTS_REPO_FULL_NAME = `${ORGANIZATION}/projects`.toLowerCase();
const RESERVED_PROJECT_ISSUE_TYPE = "Project";
// Stable GraphQL node ID for the "Project" issue type in this org.
// Run this to refresh: gh api graphql -H "GraphQL-Features: issue_types" \
//   -f query='query { organization(login: "MCF-Technologie-GmbH") { issueTypes(first: 20) { nodes { id name } } } }'
const PROJECT_ISSUE_TYPE_ID = "IT_kwDOCAEFQs4CBH8t";

// GitHub App bot login. Update this if the app slug changes.
const GITHUB_APP_BOT_LOGIN = "mcf-automation-bot[bot]";

const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_GRAPHQL_FEATURES = "issue_types";

const ISSUE_ACTIONS_TO_VALIDATE = new Set(["opened", "reopened", "edited", "typed", "untyped"]);
const ISSUE_TYPE_CHANGE_ACTIONS = new Set(["typed", "untyped", "edited"]);

// Each issue template has a `type: dropdown` field with label "Issue Type" and a
// single option equal to the type name. With only one option in the dropdown, GitHub's
// form UI does not allow users to change the value. The submitted body renders as:
//   ### Issue Type\n\nTypeName
// Map from the type name (as it appears in the dropdown) to its GraphQL node ID.
const TEMPLATE_TYPE_IDS = {
  "Bug":           "IT_kwDOCAEFQs4BKtmJ",
  "Feature":       "IT_kwDOCAEFQs4BKtmM",
  "Task":          "IT_kwDOCAEFQs4BKtmG",
  "Improvement":   "IT_kwDOCAEFQs4BpYBi",
  "Documentation": "IT_kwDOCAEFQs4CA6uB",
  "Maintenance":   "IT_kwDOCAEFQs4CA6uF",
  "DevOps":        "IT_kwDOCAEFQs4CBIei",
};

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return json({ ok: true, service: "github-automation-bot" }, 200);
    }

    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    const rawBody = await request.arrayBuffer();
    const signatureHeader = request.headers.get("X-Hub-Signature-256");
    const event = request.headers.get("X-GitHub-Event") || "unknown";
    const delivery = request.headers.get("X-GitHub-Delivery") || "unknown";

    if (!signatureHeader) {
      return json({ error: "Missing X-Hub-Signature-256 header" }, 401);
    }

    if (!env.GITHUB_WEBHOOK_SECRET) {
      console.error("Missing Cloudflare secret: GITHUB_WEBHOOK_SECRET");
      return json({ error: "Server misconfiguration: missing webhook secret" }, 500);
    }

    const isValid = await verifyGitHubSignature(
      rawBody,
      signatureHeader,
      env.GITHUB_WEBHOOK_SECRET
    );

    if (!isValid) {
      return json({ error: "Invalid signature" }, 401);
    }

    let payload;

    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    console.log("Webhook received", {
      event,
      delivery,
      action: payload.action,
      repository: payload.repository?.full_name,
      sender: payload.sender?.login,
    });

    if (event === "ping") {
      return json({ ok: true, pong: true }, 200);
    }

    if (event !== "issues") {
      return json({ ok: true, skipped: true, reason: `event=${event}` }, 200);
    }

    // Prevent feedback loops caused by our own bot restoring an issue type.
    if (payload.sender?.login === GITHUB_APP_BOT_LOGIN) {
      return json(
        {
          ok: true,
          skipped: true,
          reason: "event sent by automation bot",
        },
        200
      );
    }

    const action = payload.action;

    if (!ISSUE_ACTIONS_TO_VALIDATE.has(action)) {
      return json(
        {
          ok: true,
          skipped: true,
          reason: `issue action=${action}`,
        },
        200
      );
    }

    // "edited" without changes.type is just a title/body edit — skip it.
    if (action === "edited" && !payload.changes?.type) {
      return json(
        {
          ok: true,
          skipped: true,
          reason: "edited event without type change",
        },
        200
      );
    }

    const issue = payload.issue;
    const repository = payload.repository;
    const installationId = payload.installation?.id;

    if (!issue || !repository) {
      return json({ error: "Invalid issues payload: missing issue or repository" }, 400);
    }

    if (!installationId) {
      return json({ error: "Invalid issues payload: missing installation id" }, 400);
    }

    const owner = repository.owner?.login;
    const repo = repository.name;
    const repoFullName = normalizeRepo(repository.full_name || `${owner}/${repo}`);
    const issueNumber = issue.number;

    if (!owner || !repo || !issueNumber) {
      return json({ error: "Invalid issues payload: missing repo or issue number" }, 400);
    }

    try {
      const token = await createInstallationAccessToken(env, installationId);
      const gh = new GitHubClient(token);

      const currentIssue = await gh.getIssue(owner, repo, issueNumber);
      const currentType = currentIssue.issueType?.name || "none";

      const result = await enforceIssueTypePolicy({
        gh,
        owner,
        repo,
        repoFullName,
        issueNumber,
        action,
        currentIssue,
        currentType,
        changes: payload.changes,
      });

      return json(
        {
          ok: true,
          ...result,
        },
        200
      );
    } catch (err) {
      console.error(`Processing failed for ${repository.full_name}#${issueNumber}`, err);
      return json({ error: "Processing failed", detail: err.message }, 500);
    }
  },
};

async function enforceIssueTypePolicy({
  gh,
  owner,
  repo,
  repoFullName,
  issueNumber,
  action,
  currentIssue,
  currentType,
  changes,
}) {
  const isProjectsRepo = repoFullName === PROJECTS_REPO_FULL_NAME;
  const isProjectType = currentType === RESERVED_PROJECT_ISSUE_TYPE;
  // Type changes arrive as "typed"/"untyped" OR as "edited" with changes.type
  const isTypeChange = ISSUE_TYPE_CHANGE_ACTIONS.has(action) &&
    (action !== "edited" || changes?.type != null);

  if (isProjectsRepo) {
    return enforceProjectsRepositoryPolicy({
      gh,
      owner,
      repo,
      repoFullName,
      issueNumber,
      currentIssue,
      currentType,
      isProjectType,
    });
  }

  if (isTypeChange) {
    return revertIssueTypeChangeInImplementationRepo({
      gh,
      owner,
      repo,
      repoFullName,
      issueNumber,
      action,
      currentIssue,
      currentType,
      isProjectType,
    });
  }

  if (isProjectType) {
    return closeReservedProjectTypeInImplementationRepo({
      gh,
      owner,
      repo,
      repoFullName,
      issueNumber,
      action,
      currentType,
    });
  }

  // On creation, verify the type matches what the template declares.
  if (action === "opened" || action === "reopened") {
    return enforceTemplateTypeOnCreation({
      gh,
      owner,
      repo,
      repoFullName,
      issueNumber,
      currentIssue,
      currentType,
    });
  }

  return {
    enforced: false,
    reason: "implementation repo issue type is valid",
    action,
    repo: repoFullName,
    issue: issueNumber,
    currentType,
  };
}

async function enforceProjectsRepositoryPolicy({
  gh,
  owner,
  repo,
  repoFullName,
  issueNumber,
  currentIssue,
  currentType,
  isProjectType,
}) {
  if (isProjectType) {
    return {
      enforced: false,
      reason: "projects repo issue type is valid",
      repo: repoFullName,
      issue: issueNumber,
      currentType,
    };
  }

  // Wrong type — correct it using the hardcoded PROJECT_ISSUE_TYPE_ID constant.
  await gh.updateIssueType(currentIssue.id, PROJECT_ISSUE_TYPE_ID);

  const comment = [
    `The issue type was automatically set to \`${RESERVED_PROJECT_ISSUE_TYPE}\`.`,
    "",
    `This repository only accepts issues with the \`${RESERVED_PROJECT_ISSUE_TYPE}\` issue type.`,
  ].join("\n");

  await gh.createComment(owner, repo, issueNumber, comment);

  return {
    enforced: true,
    operation: "corrected",
    repo: repoFullName,
    issue: issueNumber,
    currentType,
    correctedTo: RESERVED_PROJECT_ISSUE_TYPE,
  };
}

async function closeReservedProjectTypeInImplementationRepo({
  gh,
  owner,
  repo,
  repoFullName,
  issueNumber,
  action,
  currentType,
}) {
  const comment = [
    `This issue was automatically closed because the \`${RESERVED_PROJECT_ISSUE_TYPE}\` issue type is reserved for \`${ORGANIZATION}/projects\`.`,
    "",
    `Current issue type: \`${currentType}\``,
    "",
    "Use a repository-specific issue type such as Bug, Feature, Improvement, Task, Documentation, Test, DevOps, Maintenance, or Research.",
  ].join("\n");

  await gh.createComment(owner, repo, issueNumber, comment);
  await gh.closeIssue(owner, repo, issueNumber, "not_planned");

  return {
    enforced: true,
    operation: "closed",
    reason: "Project issue type is reserved for projects repository",
    action,
    repo: repoFullName,
    issue: issueNumber,
    currentType,
  };
}

function detectTemplateFromIssue(body) {
  if (!body) return null;
  const match = body.match(/^### Issue Type\r?\n\r?\n([^\r\n]+)/m);
  if (!match) return null;
  const expectedType = match[1].trim();
  const expectedTypeId = TEMPLATE_TYPE_IDS[expectedType];
  if (!expectedTypeId) return null;
  return { expectedType, expectedTypeId };
}

async function enforceTemplateTypeOnCreation({
  gh,
  owner,
  repo,
  repoFullName,
  issueNumber,
  currentIssue,
  currentType,
}) {
  const template = detectTemplateFromIssue(currentIssue.body);

  if (!template) {
    return {
      enforced: false,
      reason: "no template detected — type accepted as-is",
      action: "opened",
      repo: repoFullName,
      issue: issueNumber,
      currentType,
    };
  }

  if (currentType === template.expectedType) {
    return {
      enforced: false,
      reason: "issue type matches template",
      action: "opened",
      repo: repoFullName,
      issue: issueNumber,
      currentType,
      template: template.expectedType,
    };
  }

  // Type doesn't match template — correct it.
  await gh.updateIssueType(currentIssue.id, template.expectedTypeId);

  const comment = [
    `The issue type was automatically corrected to \`${template.expectedType}\`.`,
    "",
    `This issue was created using the **${template.expectedType}** template.`,
    "",
    "Issue types are determined by the template and cannot be changed.",
  ].join("\n");

  await gh.createComment(owner, repo, issueNumber, comment);

  return {
    enforced: true,
    operation: "corrected_to_template_type",
    reason: "issue type did not match template",
    action: "opened",
    repo: repoFullName,
    issue: issueNumber,
    currentType,
    correctedTo: template.expectedType,
    template: template.expectedType,
  };
}

async function revertIssueTypeChangeInImplementationRepo({
  gh,
  owner,
  repo,
  repoFullName,
  issueNumber,
  action,
  currentIssue,
  currentType,
  isProjectType,
}) {
  // Query the issue timeline for the first type change event.
  // Its prevIssueType is the type at creation — the one we must enforce.
  const originalType = await gh.getOriginalIssueType(owner, repo, issueNumber);

  if (!originalType) {
    // No prior type change event found. This means either:
    // - The webhook raced ahead of the timeline (very unlikely), or
    // - The current type was set at creation (first assignment).
    // Close if Project type; otherwise accept it as-is.
    if (isProjectType) {
      const comment = [
        `This issue was automatically closed because the \`${RESERVED_PROJECT_ISSUE_TYPE}\` issue type is reserved for \`${ORGANIZATION}/projects\`.`,
        "",
        `Current issue type: \`${currentType}\``,
        "",
        "Use a repository-specific issue type such as Bug, Feature, Improvement, Task, Documentation, Test, DevOps, Maintenance, or Research.",
      ].join("\n");

      await gh.createComment(owner, repo, issueNumber, comment);
      await gh.closeIssue(owner, repo, issueNumber, "not_planned");

      return {
        enforced: true,
        operation: "closed",
        reason: "Project issue type is reserved (no prior type change history)",
        action,
        repo: repoFullName,
        issue: issueNumber,
        currentType,
      };
    }

    return {
      enforced: false,
      reason: "no prior type change history — treating current type as original",
      action,
      repo: repoFullName,
      issue: issueNumber,
      currentType,
    };
  }

  if (currentType === originalType.name) {
    return {
      enforced: false,
      operation: "already_original_type",
      reason: "issue type already matches original type",
      action,
      repo: repoFullName,
      issue: issueNumber,
      currentType,
    };
  }

  await gh.updateIssueType(currentIssue.id, originalType.id);

  const comment = [
    `The issue type was automatically reverted to \`${originalType.name}\`.`,
    "",
    "Issue types cannot be changed after issue creation.",
  ].join("\n");

  await gh.createComment(owner, repo, issueNumber, comment);

  return {
    enforced: true,
    operation: "reverted",
    reason: "issue type changes are not allowed after creation",
    action,
    repo: repoFullName,
    issue: issueNumber,
    currentType,
    revertedTo: originalType.name,
  };
}

class GitHubClient {
  constructor(token) {
    this.token = token;
    this.baseUrl = "https://api.github.com";
    this.graphqlUrl = "https://api.github.com/graphql";
  }

  async graphql(query, variables = {}) {
    const res = await fetch(this.graphqlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "mcf-github-automation-bot",
        "GraphQL-Features": GITHUB_GRAPHQL_FEATURES,
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
    }

    const body = JSON.parse(text);

    if (body.errors?.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
    }

    return body.data;
  }

  async rest(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "mcf-github-automation-bot",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`REST ${method} ${path} -> HTTP ${res.status}: ${text}`);
    }

    return text ? JSON.parse(text) : null;
  }

  async getIssue(owner, repo, issueNumber) {
    const data = await this.graphql(
      `query($owner: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issueNumber) {
            id
            number
            title
            body
            state
            issueType {
              id
              name
            }
          }
        }
      }`,
      { owner, repo, issueNumber }
    );

    if (!data.repository?.issue) {
      throw new Error(`Issue not found: ${owner}/${repo}#${issueNumber}`);
    }

    return data.repository.issue;
  }

  async updateIssueType(issueId, issueTypeId) {
    return this.graphql(
      `mutation($issueId: ID!, $issueTypeId: ID!) {
        updateIssueIssueType(input: {
          issueId: $issueId
          issueTypeId: $issueTypeId
        }) {
          issue {
            id
            issueType {
              id
              name
            }
          }
        }
      }`,
      { issueId, issueTypeId }
    );
  }

  async getOriginalIssueType(owner, repo, issueNumber) {
    const data = await this.graphql(
      `query($owner: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $issueNumber) {
            timelineItems(first: 1, itemTypes: [ISSUE_TYPE_CHANGED_EVENT]) {
              nodes {
                ... on IssueTypeChangedEvent {
                  prevIssueType {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }`,
      { owner, repo, issueNumber }
    );

    const nodes = data.repository?.issue?.timelineItems?.nodes ?? [];
    return nodes[0]?.prevIssueType ?? null;
  }

  async createComment(owner, repo, issueNumber, body) {
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      { body }
    );
  }

  async closeIssue(owner, repo, issueNumber, stateReason = "not_planned") {
    return this.rest(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      {
        state: "closed",
        state_reason: stateReason,
      }
    );
  }
}

async function createInstallationAccessToken(env, installationId) {
  if (!env.GITHUB_APP_ID) {
    throw new Error("Missing Cloudflare variable: GITHUB_APP_ID");
  }

  if (!env.GITHUB_PRIVATE_KEY) {
    throw new Error("Missing Cloudflare secret: GITHUB_PRIVATE_KEY");
  }

  const jwt = await createGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "mcf-github-automation-bot",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    }
  );

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Failed to create installation token: HTTP ${res.status}: ${text}`);
  }

  const body = JSON.parse(text);

  if (!body.token) {
    throw new Error("GitHub installation token response did not include token");
  }

  return body.token;
}

async function createGitHubAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: String(appId),
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const cryptoKey = await importPrivateKey(privateKeyPem);

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function importPrivateKey(privateKeyPem) {
  const der = pemToDer(privateKeyPem);

  const pkcs8Der = privateKeyPem.includes("BEGIN RSA PRIVATE KEY")
    ? wrapPkcs1RsaPrivateKeyAsPkcs8(der)
    : der;

  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8Der,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );
}

function pemToDer(pem) {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s/g, "");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function wrapPkcs1RsaPrivateKeyAsPkcs8(pkcs1DerBuffer) {
  const pkcs1 = new Uint8Array(pkcs1DerBuffer);

  const version = new Uint8Array([0x02, 0x01, 0x00]);

  const rsaAlgorithmIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);

  const privateKeyOctetString = concatBytes(
    new Uint8Array([0x04]),
    derLength(pkcs1.length),
    pkcs1
  );

  const privateKeyInfoBody = concatBytes(
    version,
    rsaAlgorithmIdentifier,
    privateKeyOctetString
  );

  return concatBytes(
    new Uint8Array([0x30]),
    derLength(privateKeyInfoBody.length),
    privateKeyInfoBody
  ).buffer;
}

function derLength(length) {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }

  const bytes = [];
  let value = length;

  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }

  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...arrays) {
  const length = arrays.reduce((total, item) => total + item.length, 0);
  const output = new Uint8Array(length);

  let offset = 0;

  for (const item of arrays) {
    output.set(item, offset);
    offset += item.length;
  }

  return output;
}

async function verifyGitHubSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const receivedHex = signatureHeader.slice("sha256=".length);

  if (receivedHex.length !== 64) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const expectedBuffer = await crypto.subtle.sign("HMAC", key, rawBody);
  const expected = new Uint8Array(expectedBuffer);
  const received = hexToUint8Array(receivedHex);

  return timingSafeEqual(expected, received);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}

function hexToUint8Array(hex) {
  const bytes = new Uint8Array(hex.length / 2);

  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function normalizeRepo(repoFullName) {
  return String(repoFullName || "").trim().toLowerCase();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}