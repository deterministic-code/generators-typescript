import { BUNDLED_LIBRARY_MODE } from "./generated-app.ts";

export const PARENT_CHILD_EAGER_YAML: Record<string, string> = {
  "settings.yaml": `settings:
  datasource:
    pluralize_datatable_names: true
  languages:
    typescript:
      library_reference_mode: bundled
`,
  "backend-app.yaml": `middleware: []
handlers: []
`,
  "types.yaml": `version: 1.0.0
types:
  - status:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - name:
            type: string
  - project:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - name:
            type: string
        - tasks:
            type: task[]
            references: task.project_id
  - task:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - title:
            type: string
        - project_id:
            type: number
            references: project.id
        - status_id:
            type: number
            references: status.id
`,
  "datasource.yaml": `version: 1.0.0
includes:
  - types:
      filter: tag == "datasource_type"
types:
  - status:
      fields:
        - name:
            is_unique: true
  - project:
      fields:
        - name:
            is_unique: true
`,
  "datasource_seeds.yaml": `version: 1.0.0
seeds:
  - status:
      - id1:
          name: active
      - id2:
          name: archived
`,
  "services.yaml": `version: 1.0.0
includes:
  - types:
      filter: tag == "datasource_type"
services: []
`,
  "routes.yaml": `version: 1.0.0
includes:
  - types:
      filter: tag == "view_type"
routes:
  - get_projects_by_name:
  - project:
      eager_read_path:
        - tasks
      eager_update_path:
        - tasks
`,
};

export const PARENT_CHILD_SETTINGS: Record<string, string> = {
  application_name: "parent-child-e2e",
  app_generate_complexity: "deterministic",
  "datasource.pluralize_datatable_names": "true",
  "backend.datasources": "sqlite",
  ...BUNDLED_LIBRARY_MODE,
};
