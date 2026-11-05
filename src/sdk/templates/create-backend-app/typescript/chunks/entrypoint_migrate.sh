{{testMigrationsExport}}DIALECT="${DATABASE_BACKEND:-sqlite}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-{{containerSqlRoot}}/${DIALECT}/migrations}"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "entrypoint: no migrations at $MIGRATIONS_DIR — starting server without migrate-up"
else
  case "$DIALECT" in
{{dialectCases}}
    *)
      echo "entrypoint: unknown DATABASE_BACKEND=$DIALECT — refusing to start" >&2
      exit 1
      ;;
  esac

  echo "entrypoint: dialect=$DIALECT migrations=$MIGRATIONS_DIR"
  echo "entrypoint: migrate-setup"
  {{setupCmd}}
  echo "entrypoint: migrate-up"
  {{upCmd}}
fi
