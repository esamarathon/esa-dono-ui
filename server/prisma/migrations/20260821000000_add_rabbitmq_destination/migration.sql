-- Add RabbitMQ destination type support to webhook endpoints.
ALTER TABLE "WebhookEndpoint" ADD COLUMN "destination_type" TEXT NOT NULL DEFAULT 'HTTP';
ALTER TABLE "WebhookEndpoint" ADD COLUMN "amqp_url" TEXT;
ALTER TABLE "WebhookEndpoint" ADD COLUMN "amqp_exchange" TEXT NOT NULL DEFAULT '';
ALTER TABLE "WebhookEndpoint" ADD COLUMN "amqp_routing_key" TEXT;
