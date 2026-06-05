export const ORGANIZATION = "MCF-Technologie-GmbH";
export const PROJECTS_REPO_FULL_NAME = `${ORGANIZATION}/projects`.toLowerCase();
export const RESERVED_PROJECT_ISSUE_TYPE = "Project";

// GitHub App bot login. Update this if the app slug changes.
export const GITHUB_APP_BOT_LOGIN = "mcf-automation-bot[bot]";

export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_GRAPHQL_FEATURES = "issue_types, issue_fields";

export const ISSUE_ACTIONS_TO_VALIDATE = new Set(["opened", "reopened", "edited", "typed", "untyped"]);
export const ISSUE_TYPE_CHANGE_ACTIONS = new Set(["typed", "untyped", "edited"]);

export const REQUIRES_WHITELIST = {
  "Documentation": "requires/docs",
  "Tests": "requires/tests",
  "Release notes": "requires/release-note",
  "Security review": "requires/security-review",
  "Migration": "requires/migration",
  "CI": "requires/ci",
  "Config": "requires/config"
};
