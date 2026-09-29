# Database Management

## Migrations

```bash
# Development: create a new migration
cd server && npx prisma migrate dev --name <name>

# Production: apply pending migrations (handled by entrypoint on container start)
cd server && npx prisma migrate deploy

# Browse data
cd server && npx prisma studio
```

## Backup

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
