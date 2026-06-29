export const fieldMethods = {
  async getOrgIssueTypes(orgName) {
    const data = await this.graphql(
      `query($orgName: String!) {
        organization(login: $orgName) {
          issueTypes(first: 50) {
            nodes {
              id
              name
            }
          }
        }
      }`,
      { orgName }
    );
    return data.organization?.issueTypes?.nodes ?? [];
  },

  async getOrgIssueFields(orgName) {
    const data = await this.graphql(
      `query($orgName: String!) {
        organization(login: $orgName) {
          issueFields(first: 50) {
            nodes {
              ... on IssueFieldSingleSelect {
                id
                name
                options {
                  id
                  name
                }
              }
              ... on IssueFieldText { id name }
              ... on IssueFieldNumber { id name }
              ... on IssueFieldDate { id name }
            }
          }
        }
      }`,
      { orgName }
    );
    return data.organization?.issueFields?.nodes ?? [];
  },

  async updateIssueFieldValue(issueId, fieldId, valueInput) {
    return this.graphql(
      `mutation($issueId: ID!, $issueField: IssueFieldCreateOrUpdateInput!) {
        updateIssueFieldValue(input: {
          issueId: $issueId
          issueField: $issueField
        }) {
          issue {
            id
          }
        }
      }`,
      {
        issueId,
        issueField: {
          fieldId,
          ...valueInput,
        },
      }
    );
  },
};
