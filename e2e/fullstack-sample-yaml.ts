import { readFile } from "node:fs/promises";

export const FULLSTACK_SAMPLE_NAMES = [
  "01-simple",
  "02-moderate",
  "03-complex",
  "04-complex-optimistic-concurrency",
] as const;

export type FullstackSampleName = (typeof FULLSTACK_SAMPLE_NAMES)[number];

const SAMPLE_FILES = [
  "types.yaml",
  "datasource.yaml",
  "routes.yaml",
] as const;

const SETTINGS_YAML = `settings:
  datasource:
    id_type: integer
    pluralize_datatable_names: true
`;

const BACKEND_APP_YAML = `middleware:
  - traceRoute:
      type: route
      enabled: true
  - traceService:
      type: service
      enabled: true
  - traceDatasource:
      type: datasource
      enabled: true
handlers: []
`;

const SERVICES_YAML = `version: 1.0.0
includes:
  - types:
      filter: tag == "datasource_type"
services: []
`;

const ROLE_SEEDS_YAML = `version: 1.0.0
seeds:
  - role:
      - id1:
          name: admin
      - id2:
          name: member
`;

const STATUS_SEEDS_YAML = `version: 1.0.0
seeds:
  - status:
      - id1:
          name: active
      - id2:
          name: archived
`;

const seedsFor = (name: FullstackSampleName): string | undefined => {
  if (name === "02-moderate") return ROLE_SEEDS_YAML;
  if (name === "03-complex" || name === "04-complex-optimistic-concurrency") {
    return STATUS_SEEDS_YAML;
  }
  return undefined;
};

export const fullstackSampleSettings = (
  name: FullstackSampleName,
): Record<string, string> => ({
  application_name: `fullstack-${name}`,
  application_tier: "full-stack",
  app_generate_complexity: "deterministic",
  frontend_generate_framework: "vite",
  "datasource.id_type": "integer",
  "datasource.pluralize_datatable_names": "true",
  "backend.datasources": "sqlite",
});

export const loadFullstackSampleYaml = async (
  name: FullstackSampleName,
): Promise<Record<string, string>> => {
  const dir = new URL(`./samples/${name}/`, import.meta.url);
  const texts = await Promise.all(
    SAMPLE_FILES.map((file) => readFile(new URL(file, dir), "utf8")),
  );
  const yaml: Record<string, string> = {
    "settings.yaml": SETTINGS_YAML,
    "backend-app.yaml": BACKEND_APP_YAML,
    "services.yaml": SERVICES_YAML,
    "types.yaml": texts[0]!,
    "datasource.yaml": texts[1]!,
    "routes.yaml": texts[2]!,
  };
  const seeds = seedsFor(name);
  if (seeds !== undefined) yaml["datasource_seeds.yaml"] = seeds;
  return yaml;
};
