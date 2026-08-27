# Stripe Webhook Registration

1. **Expose your server**: Use a reverse proxy or tunnel tool like [ngrok](https://ngrok.com):

   ```bash
   ngrok http 3001
   ```

2. **Register in Stripe**: In the Stripe Dashboard, add a webhook endpoint:

   - **URL**: `https://<your-ngrok-url>/api/webhooks/stripe`
   - **Events**: Select `checkout.session.completed`

3. **Set the secret**: Copy the signing secret (`whsec_…`) and set it in `.env`:

   ```
   STRIPE_WEBHOOK_SECRET=whsec_<your-signing-secret>
   ```

4. **Checkout sessions**: Set `STRIPE_SECRET_KEY` so `POST /api/pledge` can create hosted Checkout sessions for pledges; leave it unset to fall back to a no-hosted-checkout mode (`donate_url: null`).

During local development you can leave `STRIPE_WEBHOOK_SECRET` unset to skip HMAC signature verification.

## Metrics (Prometheus)

The backend exposes `GET /api/metrics` in Prometheus text format. It's reachable through the same public path as the rest of the API (no separate network restriction) and is protected entirely by its own bearer token.

**Metrics exposed:**

- **Runtime/process metrics** — CPU, memory, event loop lag, GC pauses (via `prom-client`'s default collectors). These are per-instance and reset on restart; that's expected and handled correctly by Prometheus's `rate()`/`increase()`.
- **HTTP metrics** — `http_requests_total` and `http_request_duration_seconds`, labeled by method/route/status.
- **Business metrics** (`dono_*`) — donor count, total donated, donation count, open pledges, active channels, reward claims, poll votes, balance adjustments by type. Computed from the database on a background interval (`METRICS_REFRESH_MS`, default 45s) and served from a cache, so scraping never triggers extra database queries — the DB is only queried once per interval, regardless of scrape frequency. Because the source of truth is the database rather than process memory, these values are correct across restarts and identical across load-balanced replicas.

### Obtaining and configuring the token

1. Generate a random secret, e.g.:

   ```bash
   openssl rand -hex 32
   ```

2. Set it as `METRICS_API_KEY` in your `.env` (or the container's environment):

   ```
   METRICS_API_KEY=<your-generated-secret>
   ```

   If `METRICS_API_KEY` is left unset, `/api/metrics` returns `404` rather than serving unauthenticated data.

3. Point Prometheus (or curl) at the endpoint using the `key_metrics_` prefix, following the same `Authorization: Bearer` scheme used by the admin/moderator keys:

   ```bash
   curl -H "Authorization: Bearer key_metrics_<your-generated-secret>" http://localhost:3001/api/metrics
   ```

   Example `scrape_configs` entry for a Prometheus server:

   ```yaml
   scrape_configs:
     - job_name: dono-backend
       metrics_path: /api/metrics
       scheme: https
       authorization:
         credentials: key_metrics_<your-generated-secret>
       static_configs:
         - targets: ['donations.example.com']
   ```

Since the endpoint is public, it's also rate-limited per IP (`RATE_LIMIT_METRICS`, default 30/min) as a backstop against unauthenticated scraping/scanning traffic.
