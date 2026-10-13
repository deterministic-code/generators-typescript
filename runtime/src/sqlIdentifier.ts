const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertValidIdentifier(name: string): string {
  if (!VALID_IDENTIFIER.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
}

export function quoteIdentifier(name: string): string {
  return `"${assertValidIdentifier(name)}"`;
}

export function quoteMysqlIdentifier(name: string): string {
  return `\`${assertValidIdentifier(name)}\``;
}

export function quoteSqlserverIdentifier(name: string): string {
  return `[${assertValidIdentifier(name)}]`;
}
