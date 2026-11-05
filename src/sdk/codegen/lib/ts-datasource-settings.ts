import { DatasourceSettings } from "../../datasource-settings.ts";
import { tsLiteral } from "./ts-sample-literal.ts";

type DatasourceInput = NonNullable<
  ConstructorParameters<typeof DatasourceSettings>[0]
>;

interface SettingsWithDatasource {
  datasource?: DatasourceInput;
}

export interface DatasourceOptions {
  idType?: string;
  uuid?: string;
  datetime?: string;
  pluralizeTableNames?: boolean;
  useStoredProcedures?: boolean;
  useOptimisticConcurrency?: boolean;
}

/** `DatasourceSettings` from loader-resolved settings — the production path. The loader (`read-settings` over `default-settings.yaml`) already applied every default, so this re-defaults nothing; it just wraps `settings.datasource`. */
export function datasourceSettingsForSettings(
  settings: SettingsWithDatasource,
): DatasourceSettings {
  return new DatasourceSettings(settings.datasource);
}

/** The project id_type resolved through `DatasourceSettings` (so the loader default applies), or `undefined` when there is no settings object — the one place the validator wiring reads id_type from settings. */
export function idTypeFromSettings(
  settings?: SettingsWithDatasource,
): string | undefined {
  return settings ? datasourceSettingsForSettings(settings).idType : undefined;
}

/** `DatasourceSettings` from a generic (possibly partial) generate-options object — the direct-call/unit-test adapter, mirroring `namesFor`. Absent knobs fall back to the class defaults (integer / string uuid / native datetime). */
export function datasourceSettingsFor(
  opts: DatasourceOptions = {},
): DatasourceSettings {
  return new DatasourceSettings({
    idType: opts.idType,
    uuid: opts.uuid,
    datetime: opts.datetime,
    pluralizeDatatableNames: opts.pluralizeTableNames,
    useStoredProcedures: opts.useStoredProcedures,
    useOptimisticConcurrency: opts.useOptimisticConcurrency,
  });
}

/** The `settingsConfig` object literal `createBackendApp` inlines, rendered from a resolved `DatasourceSettings` — so an generated test/app supplies settings directly and never disk-loads `settings.yaml`. Maps `datetimeRepr`→`datetime`, `uuidRepr`→`uuid`. */
export function settingsConfigLiteral(ds: DatasourceSettings): string {
  return tsLiteral({
    pluralizeTableNames: ds.pluralizeTableNames,
    datetime: ds.datetimeRepr,
    uuid: ds.uuidRepr,
    idType: ds.idType,
  });
}
