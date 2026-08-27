# Simulating Donations

Three methods for testing without real money:

## Option A — Admin UI

Visit `/admin/simulate`, fill in donor email + amount, click "Simulate Donation". Copy the generated magic link to access the donor wallet.

## Option B — curl (direct webhook POST)

When `STRIPE_WEBHOOK_SECRET` is unset, HMAC verification is skipped:

```bash
curl -X POST http://localhost:3001/api/webhooks/stripe \
  -H "Content-Type: application/json" \
  -d '{"type":"checkout.session.completed","data":{"object":{"id":"cs_test_123","amount_total":1000,"customer_details":{"email":"test@example.com","name":"Test"}}}}'
```

## Option C — Admin API

```bash
curl -X POST http://localhost:3001/api/admin/simulate-donation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer key_admin_change-me" \
  -d '{"email":"test@example.com","amount_cents":1000}'
```

Returns `{ success: true, token, donor }`. Build a magic link: `http://localhost:5173/api/auth/magic?token=<token>` (sets the session cookie, redirects to the wallet).
