import { GITHUB_API_VERSION, GITHUB_GRAPHQL_FEATURES } from "../../config.js";
import { createGitHubAppJwt } from "../../utils/crypto.js";

export class BaseGitHubClient {
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
}

export function encodeRefPath(ref) {
  return String(ref || "").split("/").map(encodeURIComponent).join("/");
}

export async function createInstallationAccessToken(env, installationId) {
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
