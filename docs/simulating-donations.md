# Simulating Donations

Three methods for testing without real money:

## Option A — Admin UI

Visit `/admin/simulate`, fill in donor email + amount, click "Simulate Donation". Copy the generated magic link to access the donor wallet.

## Option B — curl (direct webhook POST)

When `TILTIFY_WEBHOOK_SECRET` is unset, HMAC verification is skipped:

```bash
curl -X POST http://localhost:3001/api/webhooks/tiltify \
  -H "Content-Type: application/json" \
  -d '{"meta":{"event_type":"donation.completed"},"data":{"id":"test-123","donor_email":"test@example.com","donor_name":"Test","amount":{"value":"10.00"},"comment":"test"}}'
```

## Option C — Admin API

```bash
curl -X POST http://localhost:3001/api/admin/simulate-donation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer key_admin_change-me" \
  -d '{"email":"test@example.com","amount_cents":1000}'
```

Returns `{ success: true, token, donor }`. Build a magic link: `http://localhost:5173/api/auth/magic?token=<token>` (sets the session cookie, redirects to the wallet).
