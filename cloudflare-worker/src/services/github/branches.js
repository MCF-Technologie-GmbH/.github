import { encodeRefPath } from "./client.js";

export const branchMethods = {
  async createLinkedBranch({ issueId, repositoryId, branchName, baseOid }) {
    if (!issueId || !repositoryId || !branchName || !baseOid) {
      throw new Error("Missing linked branch inputs: issueId, repositoryId, branchName, and baseOid are required.");
    }

    return this.graphql(
      `mutation($input: CreateLinkedBranchInput!) {
        createLinkedBranch(input: $input) {
          clientMutationId
          linkedBranch {
            id
            ref {
              name
              prefix
              target {
                oid
              }
            }
          }
        }
      }`,
      {
        input: {
          issueId,
          repositoryId,
          name: branchName,
          oid: baseOid,
        },
      }
    );
  },

  async deleteLinkedBranch(linkedBranchId) {
    if (!linkedBranchId) {
      throw new Error("Missing linkedBranchId.");
    }

    return this.graphql(
      `mutation($input: DeleteLinkedBranchInput!) {
        deleteLinkedBranch(input: $input) {
          clientMutationId
        }
      }`,
      {
        input: { linkedBranchId },
      }
    );
  },

  async getReference(owner, repo, ref) {
    return this.rest(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeRefPath(ref)}`
    );
  },

  async createReference(owner, repo, ref, sha) {
    return this.rest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
      { ref, sha }
    );
  },

  async deleteReference(owner, repo, ref) {
    return this.rest(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/${encodeRefPath(ref)}`
    );
  },
};
