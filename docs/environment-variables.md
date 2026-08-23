# Environment Variables

| Variable                   | Required   | Default                                    | Description                                                                                                               |
| -------------------------- | ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `TILTIFY_CLIENT_ID`        | Yes        | —                                          | Tiltify OAuth2 client ID                                                                                                  |
| `TILTIFY_CLIENT_SECRET`    | Yes        | —                                          | Tiltify OAuth2 client secret                                                                                              |
| `TILTIFY_CAMPAIGN_ID`      | Yes        | —                                          | Tiltify campaign ID to proxy                                                                                              |
| `TILTIFY_DONATE_URL`       | No         | —                                          | Static Tiltify donate page URL (fallback when relay not configured)                                                       |
| `TILTIFY_DONATE_ID`        | No         | —                                          | Campaign identifier in the donate URL (UUID or `@username/slug`)                                                          |
| `TILTIFY_WEBHOOK_RELAY_ID` | No         | —                                          | Webhook Relay ID from Tiltify Developer Dashboard                                                                         |
| `TILTIFY_WEBHOOK_SECRET`   | No         | —                                          | HMAC secret for webhook verification (omit to skip verification during dev)                                               |
| `ADMIN_API_KEY`            | Yes (prod) | —                                          | Admin API key passed as `Authorization: Bearer key_admin_<key>`                                                           |
| `MODERATOR_API_KEY`        | No         | —                                          | Operational fallback key passed as `Authorization: Bearer key_mod_<key>` for moderator routes, independent of donor roles |
| `METRICS_API_KEY`          | No         | —                                          | Token for `GET /api/metrics`, passed as `Authorization: Bearer key_metrics_<key>`. Endpoint returns 404 if unset          |
| `METRICS_REFRESH_MS`       | No         | `45000`                                    | How often DB-derived business metrics are refreshed into the cache served by `/api/metrics`                               |
| `ADMIN_EMAILS`             | No         | —                                          | Comma-separated emails granted the ADMIN role at request time (not on donation)                                           |
| `MODERATOR_EMAILS`         | No         | —                                          | Comma-separated emails granted the MODERATOR role at request time (not on donation)                                       |
| `SMTP_HOST`                | No         | —                                          | SMTP server hostname (omit to log magic links to stdout instead)                                                          |
| `SMTP_PORT`                | No         | `587`                                      | SMTP server port                                                                                                          |
| `SMTP_SECURE`              | No         | `false`                                    | Use TLS (set `true` for port 465)                                                                                         |
| `SMTP_USER`                | No         | —                                          | SMTP authentication username                                                                                              |
| `SMTP_PASS`                | No         | —                                          | SMTP authentication password                                                                                              |
| `EMAIL_FROM`               | No         | `Donation Platform <no-reply@example.com>` | From address for magic link emails                                                                                        |
| `APP_BASE_URL`             | No         | `http://localhost:5173`                    | Base URL for magic links in emails                                                                                        |
| `PORT`                     | No         | `3001`                                     | Server listen port                                                                                                        |
| `DATABASE_URL`             | No         | `file:./dev.db`                            | Prisma database URL (SQLite)                                                                                              |
| `RATE_LIMIT_SPEND`         | No         | `20`                                       | Max spend requests per minute per donor                                                                                   |
| `RATE_LIMIT_AUTH`          | No         | `5`                                        | Max auth/magic-link requests per minute per IP                                                                            |
| `RATE_LIMIT_METRICS`       | No         | `30`                                       | Max `/api/metrics` requests per minute per IP (public endpoint, gated only by the metrics token)                          |
