process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.METRICS_API_KEY = 'test-metrics-key';
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_WEBHOOK_SECRET = '';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.SMTP_HOST = 'localhost';
process.env.SMTP_PORT = '1025';
process.env.EMAIL_FROM = 'test@example.com';
// High ceiling so the feedback route's IP-keyed rate limiter doesn't trip
// across the many requests a single test file issues from the same IP.
process.env.RATE_LIMIT_FEEDBACK = '1000';
