# Database Management

## Provider selection

The same backend image supports SQLite and PostgreSQL. Set `DATABASE_URL` to an
absolute `file:` URL for SQLite or a `postgresql:` / `postgres:` URL for PostgreSQL.
Compose defaults to `file:/data/dono.db`; set the URL in its environment file to
connect to an existing PostgreSQL service. PostgreSQL requires permission to apply
DDL migrations, including trigger functions. No source edit or image rebuild is
needed to change providers.

The target database has its own data. Changing the URL does **not** transfer data
from another database. Existing SQLite-to-PostgreSQL data transfer is not included.
Uploaded images still need the backend data volume on either provider.

## Migrations

```bash
# Generate BOTH clients after installation or a model change
npm run db:generate --workspace server

# Apply the selected provider's migrations (also done on container startup)
npm run db:migrate --workspace server

# Browse SQLite; for PostgreSQL use --schema prisma/postgresql/schema.prisma
cd server && npx prisma studio
```

`server/prisma/schema.prisma` is the single source of model definitions. The
generation command derives the PostgreSQL schema and generates both clients; the
derived files are not committed. Migration histories are separate: existing
SQLite migrations stay under `server/prisma/migrations`, and PostgreSQL starts
from an empty-schema baseline under `server/prisma/postgresql/migrations`.
When models change, add migrations for **both** providers and preserve custom
checks, partial unique indexes and ownership triggers; Prisma does not model them.

Transactions retain the existing serialized financial model. PostgreSQL uses a
transaction-scoped advisory lock before application reads, not process-local
locking. This does not enable multiple backend replicas: webhook dispatch still
uses an in-process single-flight guard.

## Tests

`npm test` uses fresh temporary SQLite storage, including historical migrations.
To test PostgreSQL, provision a disposable PostgreSQL service and run:

```bash
TEST_DATABASE_URL=postgresql://localhost/dono_test npm run test --workspace server
```

The harness creates and removes its own unique schema. It never uses the ambient
application `DATABASE_URL` as a test target. PostgreSQL runs the current-schema
suite, including rollback and concurrency checks; four historical SQLite
transition/migration test files remain SQLite-only.

## Backup

For PostgreSQL, use `pg_dump` and the PostgreSQL service's supported restore
procedure. Its data is not in the backend volume.

SQLite databases are single-file — backup is a file copy. **Stop or pause writes before backing up** to avoid corruption:

```bash
# Option 1: Stop server, copy the file
docker compose stop dono-backend
cp /path/to/volume/dono.db dono-backup-$(date +%Y%m%d).db
docker compose start dono-backend

# Option 2: sqlite3 .backup (online, atomic)
sqlite3 /path/to/volume/dono.db ".backup 'dono-backup-$(date +%Y%m%d).db'"
```

For the Docker Compose setup, the DB lives at `/data/dono.db` inside the backend container. Copy it out with:

```bash
docker compose cp dono-backend:/data/dono.db ./dono-backup.db
```
