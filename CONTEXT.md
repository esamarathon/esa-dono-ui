# CONTEXT

Domain language for esa-dono-ui. Use these words in code, issues, tests and docs. The
"Avoid" column is guidance, not a ban: prefer the defined term so a reader never has to
guess which concept is meant.

## Glossary

| Term                | Means                                                                                                                                                                | Avoid                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Event**           | A charity event: a marathon, or a one-day stream event. Parent of Channels.                                                                                          | occasion, campaign, team campaign |
| **Channel**         | One stream within an Event.                                                                                                                                          | stream, campaign                  |
| **Primary channel** | The Channel an Event routes a donation to when the donation names no Channel. An active Event always has an active one.                                              | default channel                   |
| **Slug**            | The lowercase, URL- and routing-safe name of an Event or Channel (`esa-summer-2025`), unique across both. Used in `/donate/<event>/<channel>` and AMQP routing keys. | handle, key, short name           |
| **Webhook message** | One outbound notification that something happened (for example, a donation was made).                                                                                | event, webhook event              |
| **Destination**     | Where webhook messages are sent: an HTTP URL or a RabbitMQ exchange.                                                                                                 | endpoint, event destination       |
| **Delivery**        | One queued attempt to send one webhook message to one Destination.                                                                                                   | job, event delivery               |

## "Event" versus "webhook message"

**Event** always means the charity event. A notification sent to a Destination is a
**webhook message**, and its kind is its **message type** (`donation.created`,
`incentive.enabled`, …). Code under `server/services/webhooks/` uses "message", and an
ESLint warning flags new `Event`-named identifiers there.

Exceptions, because they are external contracts:

- HTTP header `X-Webhook-Event` and AMQP header `x-webhook-event`.
- Admin API field `event_types` on a Destination, and the delivery-log field `event_type`.
- Database column `event_type` (mapped to `message_type` in Prisma).

"Webhook event" is the industry term for these, so outside consumers are not confused by it.

See `docs/adr/0006-webhook-vocabulary.md`.

## Event and Channel identity

- An **Event** contains one or more **Channels**. Every Channel belongs to exactly one Event.
- Ids are UUIDs.
- A **slug** cannot change while its Event or Channel is active. Overlays bind to it, and published links contain it.

See `docs/adr/0008-event-channel-identity.md`.
