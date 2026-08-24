import type {
  ITypeFieldConverter,
  SupportedDatasource,
  SupportedLanguage,
} from './ITypeFieldConverter';
import {
  booleanFieldConverter,
  mysqlBooleanFieldConverter,
  postgresBooleanFieldConverter,
} from './booleanFieldConverter';
import {
  dateTimeFieldConverter,
  mysqlDateTimeFieldConverter,
  postgresDateTimeFieldConverter,
} from './dateTimeFieldConverter';
import {
  binaryFieldConverter,
  mysqlBinaryFieldConverter,
  postgresBinaryFieldConverter,
} from './binaryFieldConverter';
import {
  uuidFieldConverter,
  mysqlUuidFieldConverter,
  postgresUuidFieldConverter,
} from './uuidFieldConverter';
import { makeIdentityFieldConverter } from './identityFieldConverter';
import { makeDecimalFieldConverter } from './decimalFieldConverter';

const IDENTITY_TYPES = [
  'string',
  'character',
  'number',
  'integer',
  'biginteger',
  'smallinteger',
  'float',
];

interface DialectConverters {
  boolean: ITypeFieldConverter;
  binary: ITypeFieldConverter;
  datetimeNative: ITypeFieldConverter;
  uuidNative: ITypeFieldConverter;
}

const DIALECTS: Record<SupportedDatasource, DialectConverters> = {
  sqlite: {
    boolean: booleanFieldConverter,
    binary: binaryFieldConverter,
    datetimeNative: dateTimeFieldConverter,
    uuidNative: uuidFieldConverter,
  },
  mysql: {
    boolean: mysqlBooleanFieldConverter,
    binary: mysqlBinaryFieldConverter,
    datetimeNative: mysqlDateTimeFieldConverter,
    uuidNative: mysqlUuidFieldConverter,
  },
  postgres: {
    boolean: postgresBooleanFieldConverter,
    binary: postgresBinaryFieldConverter,
    datetimeNative: postgresDateTimeFieldConverter,
    uuidNative: postgresUuidFieldConverter,
  },
};

function buildConverterMap(
  datasource: SupportedDatasource,
): Map<string, ITypeFieldConverter> {
  const dialect = DIALECTS[datasource];
  const map = new Map<string, ITypeFieldConverter>();
  for (const t of IDENTITY_TYPES) {
    map.set(t, makeIdentityFieldConverter(t, datasource));
  }
  map.set('decimal', makeDecimalFieldConverter(datasource));
  map.set('boolean', dialect.boolean);
  map.set('binary', dialect.binary);
  map.set('datetime', dialect.datetimeNative);
  map.set('uuid', dialect.uuidNative);
  return map;
}

export function getDefaultConverters(
  fromDatasource: SupportedDatasource,
  toLanguage: SupportedLanguage,
): Map<string, ITypeFieldConverter> {
  if (toLanguage !== 'typescript') {
    throw new Error(
      `getDefaultConverters: unsupported language '${toLanguage}' (only 'typescript' supported)`,
    );
  }
  return buildConverterMap(fromDatasource);
}
