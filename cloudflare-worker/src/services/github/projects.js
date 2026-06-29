export const projectMethods = {
  async addProjectV2ItemById(projectId, contentId) {
    const res = await this.graphql(
      `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item {
            id
          }
        }
      }`,
      { projectId, contentId }
    );
    return res.addProjectV2ItemById?.item;
  },

  async updateProjectV2ItemFieldValue(projectId, itemId, fieldId, valueInput) {
    return this.graphql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: $value
        }) {
          projectV2Item {
            id
          }
        }
      }`,
      { projectId, itemId, fieldId, value: valueInput }
    );
  },

  async getProjectFieldsAndId(orgName, projectNumber) {
    const data = await this.graphql(
      `query($orgName: String!, $projectNumber: Int!) {
        organization(login: $orgName) {
          projectV2(number: $projectNumber) {
            id
            title
            fields(first: 50) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  dataType
                  options {
                    id
                    name
                  }
                }
                ... on ProjectV2Field {
                  id
                  name
                  dataType
                }
              }
            }
          }
        }
      }`,
      { orgName, projectNumber }
    );
    return data.organization?.projectV2 ?? null;
  },
};
