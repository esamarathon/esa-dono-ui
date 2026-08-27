# Troubleshooting

## SMTP not working / magic links not received

- Without `SMTP_HOST` set, magic links are **logged to stdout** instead of emailed. Check server logs.
- Verify SMTP credentials: `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, `SMTP_SECURE`.
- Common SMTP issues: port 587 requires `SMTP_SECURE=false` (STARTTLS), port 465 requires `SMTP_SECURE=true` (TLS).
- Check `EMAIL_FROM` is a valid address for your SMTP provider.
- Ensure `APP_BASE_URL` is set correctly — it's used to build the magic link URL in emails.

## HMAC signature verification failure (HTTP 401 on webhook)

- If the signature doesn't match, the webhook returns 401. Check that `STRIPE_WEBHOOK_SECRET` matches the signing secret in the Stripe Dashboard.
- During local development, you can leave `STRIPE_WEBHOOK_SECRET` unset to skip verification.
- The webhook route must be mounted **before** `express.json()` — this is handled correctly in `server/index.ts` but note it if modifying middleware order.

## Magic link token expired / login fails

- Donor tokens have a TTL (set in `processDonation`). If expired, the donor needs a new donation to receive a fresh token.
- Check `DATABASE_URL` points to the correct database file. The token is stored in the `Donor.magic_token` column.
- If using containers, ensure the `/data` volume is mounted and persistent. A new container without the volume will have an empty database with no donor records.

## Database locked / busy errors (SQLite)

- SQLite handles concurrent reads but serializes writes. Under high write load, you may see `SQLITE_BUSY` errors.
- The app uses Prisma transactions for all balance mutations to keep writes atomic.
- For production at scale, consider migrating to PostgreSQL (change `datasource.provider` and `DATABASE_URL`).

## Event destination not receiving deliveries

- Check the destination's delivery log in `/admin/destinations` (expand the row) — `PENDING` rows are still retrying; `FAILED` rows have exhausted 5 attempts (~1 hour of backoff) and will **not** retry automatically.
- For HTTP destinations, verify `verify_ssl` matches your certificate (a self-signed cert with `verify_ssl: true` will fail every attempt).
- For RabbitMQ destinations, confirm the exchange/queue already exists — the app does not declare topology, it only publishes to `amqp_exchange`/`amqp_routing_key` as configured.
- Use the "test" action on a destination to send a synthetic ping and confirm wiring end-to-end before debugging a specific event type.
