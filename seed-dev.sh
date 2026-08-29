#!/usr/bin/env bash
# Seed a running esa-dono-ui backend with demo data: channels, rewards,
# auctions, polls, goals, donations, claims, votes, and contributions.
#
# Every incentive type (rewards, auctions, polls, goals) is seeded with at
# least one SHARED item (channel_id null, visible from any channel's donate
# flow) and one STREAM item (scoped to a specific channel), so the demo
# exercises both halves of the shared/channel-scoped split throughout.
# Rewards and auctions also get a small test image (uploaded via the
# moderator image-upload endpoint), so the reward/auction cards render with
# real images rather than placeholders.
#
# Auth (ADR 0004): admin routes require `Authorization: Bearer key_admin_<key>`;
# donor spend routes require `Authorization: Bearer <magic-token>`. The legacy
# `X-Admin-Key` header and `?token=` query param are no longer accepted.
#
# Usage:
#   ./seed-dev.sh [BASE] [CLIENT] [ADMIN_KEY]
#     BASE       backend base URL (default http://localhost:3001)
#     CLIENT     frontend base URL for magic links (default http://localhost:5173)
#     ADMIN_KEY  admin API key (default $ADMIN_API_KEY or "change-me")
set -e

BASE=${1:-http://localhost:3001}
CLIENT=${2:-http://localhost:5173}
KEY=${3:-${ADMIN_API_KEY:-change-me}}

AUTH="Authorization: Bearer key_admin_$KEY"

echo "==> Seeding $BASE (admin key: $KEY)"

# Wait for server to be ready
echo -n "Waiting for server..."
for i in $(seq 1 30); do
  curl -sf "$BASE/api/health" > /dev/null 2>&1 && break
  echo -n "."
  sleep 1
done
echo " ready."

# --- Test images ---
# Small (~200-260 byte) solid-color webp images, embedded as base64 so seeding
# stays dependency-free (no network fetch, no image-generation toolchain) yet
# every reward/auction gets a real uploaded image, not a placeholder URL.
# Uploaded via the moderator image-upload endpoint (admin key satisfies
# moderatorAuth too), which resizes/re-encodes and returns the served URL.
echo "==> Uploading test images..."
IMG_DIR=$(mktemp -d)
trap 'rm -rf "$IMG_DIR"' EXIT

upload_image() {
  local name=$1 b64=$2
  local path="$IMG_DIR/$name.webp"
  printf '%s' "$b64" | base64 -d > "$path"
  curl -sf -X POST "$BASE/api/moderator/uploads" -H "$AUTH" -F "file=@$path;type=image/webp" | jq -r .url
}

IMG_REWARD_SHOUTOUT=$(upload_image "reward-shoutout" "UklGRtIAAABXRUJQVlA4IMYAAACQEwCdASpAAfAAPp1OpE4lpCOiICgAsBOJaW7hd2Ee3AAAFZu14uTkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk4UAA/v9hw/+Cepco///PTP62/j/xzfdaGMCAAAAAAAAAAAA=")
IMG_REWARD_DISCORD=$(upload_image "reward-discord" "UklGRtoAAABXRUJQVlA4IM4AAACQEwCdASpAAfAAPp1OpE4lpCOiICgAsBOJaW7hd2EaHAAAE9gHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZMQAA/v9hw/9ahdt5H/xC72MxwcGy8aYKsvTz3wIeG+BAAAAAAAAAAAAAAA==")
IMG_REWARD_SHIRT=$(upload_image "reward-shirt" "UklGRs4AAABXRUJQVlA4IMIAAABQEwCdASpAAfAAPp1OpE4lpCOiICgAsBOJaW7hd2EbQAtLZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfWAAP7+xF/Ox78H//+LQ/t5/wa2tqBsoEAAAAAAAAAAAA==")
IMG_REWARD_GAME=$(upload_image "reward-game" "UklGRs4AAABXRUJQVlA4IMIAAACQEwCdASpAAfAAPp1OpE4lpCOiICgAsBOJaW7hd2Ee3AAAFZu14uTkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk4UAA/v+z1n//7FnLYGar/9RrY1SAAAAAAAAAAAAAAA==")
IMG_AUCTION_SHARED=$(upload_image "auction-shared" "UklGRsoAAABXRUJQVlA4IL4AAABQEwCdASpAAfAAPp1OpE4lpCOiICgAsBOJaW7hd2EbQAtLZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfWAAP7/mRv/9St+uikZ+YVSq9AAAAAAAAAAAAAA")
IMG_AUCTION_STREAM=$(upload_image "auction-stream" "UklGRvwAAABXRUJQVlA4IPAAAADwEwCdASpAAfAAPp1OpE4lpCOiICgAsBOJaW7hd2EQnAAAFpiwgu0qBZLteLzL9PbJyHvtk5xEXJyHvtk5D6F9LteLk5D325l+ntk5D32yc4iLk5D32ych9C+l2vFych77cy/T2ych77ZOcRFych77ZOQ+hfS7Xi5OQ99uZfp7ZOQ99snOIi5OQ99snIfQvpdrxcnIe+3Mv09snIe+2TnERcnIe+2ThQAA/v+m9///gN18W0y//hyp9O24wQ2Sy3gRC+waf/0MLijDC4owwuKMMLijDC4owwuKMMLijDC4owwuKMMLijDC4owwuKMIAAA=")
echo "   6 test images uploaded."

# --- Channels ---
# Channels replace the former "events": a donation routes to exactly one
# channel, and incentives are either shared (no channel_id) or channel-scoped.
echo "==> Creating channels..."
C_MAIN=$(curl -sf -X POST $BASE/api/admin/channels \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d '{"name":"Main Marathon","is_active":true}' | jq -r .id)

C_BONUS=$(curl -sf -X POST $BASE/api/admin/channels \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d '{"name":"Bonus Stream","is_active":true}' | jq -r .id)

echo "   Channels: $C_MAIN (Main Marathon) $C_BONUS (Bonus Stream)"

# --- Rewards ---
# Shoutouts and the Discord role are left shared (no channel_id) — available
# from either channel's donate flow. The t-shirt and game pick are scoped to
# the Main Marathon, to demonstrate a channel-specific incentive. All four
# carry a real uploaded test image.
echo "==> Creating rewards..."
R_SHOUT=$(curl -sf -X POST $BASE/api/admin/rewards \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{\"title\":\"Shoutout on Stream\",\"description\":\"Get shouted out live during the broadcast\",\"type\":\"SHOUTOUT\",\"cost_cents\":500,\"is_active\":true,\"image_url\":\"$IMG_REWARD_SHOUTOUT\"}" | jq -r .id)

R_DISC=$(curl -sf -X POST $BASE/api/admin/rewards \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{\"title\":\"Exclusive Discord Role\",\"description\":\"Permanent donor role in the ESA Discord\",\"type\":\"DIGITAL\",\"cost_cents\":1000,\"quantity_total\":50,\"is_active\":true,\"image_url\":\"$IMG_REWARD_DISCORD\"}" | jq -r .id)

R_SHIRT=$(curl -sf -X POST $BASE/api/admin/rewards \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{\"title\":\"ESA T-Shirt\",\"description\":\"Official ESA charity event t-shirt, shipped to you\",\"type\":\"PHYSICAL\",\"cost_cents\":2500,\"quantity_total\":20,\"is_active\":true,\"channel_id\":\"$C_MAIN\",\"image_url\":\"$IMG_REWARD_SHIRT\"}" | jq -r .id)

R_GAME=$(curl -sf -X POST $BASE/api/admin/rewards \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{\"title\":\"Pick the Next Game\",\"description\":\"Choose the next game the runners play\",\"type\":\"CUSTOM\",\"cost_cents\":5000,\"quantity_total\":1,\"is_active\":true,\"custom_type_label\":\"Your game pick\",\"channel_id\":\"$C_MAIN\",\"image_url\":\"$IMG_REWARD_GAME\"}" | jq -r .id)

echo "   Rewards: $R_SHOUT $R_DISC $R_SHIRT $R_GAME"

# --- Auctions ---
# A1 (signed memorabilia) is left shared — biddable from either channel's
# donate flow. A2 (dev commentary session) is scoped to the Bonus Stream, to
# demonstrate a channel-specific auction alongside the shared one. Bidding
# requires a verified-email donor with a prior donation (see docs/adr), which
# simulate-donation-created donors don't have, so no bids are placed here —
# these are listings for the admin/auction UI and donate-flow to render.
echo "==> Creating auctions..."
ENDS_AT=$(date -u -d '+3 days' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v+3d '+%Y-%m-%dT%H:%M:%SZ')

A_SHARED=$(curl -sf -X POST $BASE/api/admin/auctions \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{\"title\":\"Signed Event Poster\",\"description\":\"Poster signed by the whole runner lineup\",\"type\":\"PHYSICAL\",\"starting_price_cents\":1000,\"min_increment_cents\":500,\"ends_at\":\"$ENDS_AT\",\"is_active\":true,\"image_url\":\"$IMG_AUCTION_SHARED\"}" | jq -r .id)

A_STREAM=$(curl -sf -X POST $BASE/api/admin/auctions \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{\"title\":\"1-on-1 Dev Commentary Session\",\"description\":\"30 minutes with a developer during the Bonus Stream\",\"type\":\"CUSTOM\",\"custom_type_label\":\"Session topic\",\"starting_price_cents\":2000,\"min_increment_cents\":1000,\"ends_at\":\"$ENDS_AT\",\"is_active\":true,\"channel_id\":\"$C_BONUS\",\"image_url\":\"$IMG_AUCTION_STREAM\"}" | jq -r .id)

echo "   Auctions: $A_SHARED (shared) $A_STREAM (Bonus Stream)"

# --- Polls ---
# P1 (pick the finale game) belongs to the Main Marathon; P2 (bonus
# challenge) belongs to the Bonus Stream — each only shows up once its
# channel is selected on /donate. P3 (overall event vibe) is left shared, so
# it shows up regardless of channel, alongside the two stream-scoped polls.
echo "==> Creating polls..."
P1_JSON=$(curl -sf -X POST $BASE/api/admin/polls \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{\"title\":\"Which game should be the finale run?\",\"description\":\"Vote with your donor balance — \$1 = 1 vote\",\"is_active\":true,\"channel_id\":\"$C_MAIN\",\"options\":[{\"label\":\"Celeste\"},{\"label\":\"Hollow Knight\"},{\"label\":\"Hades\"},{\"label\":\"Disco Elysium\"}]}")
P2_JSON=$(curl -sf -X POST $BASE/api/admin/polls \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{\"title\":\"Bonus challenge for the speedrun?\",\"description\":\"Pick what happens during the bonus block\",\"is_active\":true,\"channel_id\":\"$C_BONUS\",\"options\":[{\"label\":\"Blindfolded segment\"},{\"label\":\"Developers commentary\"},{\"label\":\"Donation war: blinds vs. no blinds\"},{\"label\":\"Community race\"}]}")
P3_JSON=$(curl -sf -X POST $BASE/api/admin/polls \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d '{"title":"Best moment of the event so far?","description":"Shared across both channels — vote from either donate flow","is_active":true,"allow_custom_entries":true,"max_entry_chars":80,"options":[{"label":"The Celeste no-death run"},{"label":"The bonus couch stream reveal"}]}')

P1=$(echo $P1_JSON | jq -r .id)
P2=$(echo $P2_JSON | jq -r .id)
P3=$(echo $P3_JSON | jq -r .id)

OPT_CELESTE=$(echo $P1_JSON | jq -r '.options[] | select(.label=="Celeste") | .id')
OPT_HOLLOW=$(echo $P1_JSON | jq -r '.options[] | select(.label=="Hollow Knight") | .id')
OPT_HADES=$(echo $P1_JSON | jq -r '.options[] | select(.label=="Hades") | .id')
OPT_DISCO=$(echo $P1_JSON | jq -r '.options[] | select(.label=="Disco Elysium") | .id')
OPT_BLIND=$(echo $P2_JSON | jq -r '.options[] | select(.label=="Blindfolded segment") | .id')
OPT_DEV=$(echo $P2_JSON | jq -r '.options[] | select(.label=="Developers commentary") | .id')
OPT_RACE=$(echo $P2_JSON | jq -r '.options[] | select(.label=="Community race") | .id')
OPT_NODEATH=$(echo $P3_JSON | jq -r '.options[] | select(.label=="The Celeste no-death run") | .id')

echo "   Polls: $P1 (Main) $P2 (Bonus) $P3 (shared)"

# --- Goals ---
# G1 (bonus couch stream) belongs to the Bonus Stream; G2 and G3 are left
# shared (fed by donations to either channel).
echo "==> Creating goals..."
G1=$(curl -sf -X POST $BASE/api/admin/goals \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{\"title\":\"Unlock Bonus Couch Stream\",\"description\":\"Hit this goal and the team does an extra 2-hour couch commentary stream\",\"target_cents\":100000,\"is_active\":true,\"channel_id\":\"$C_BONUS\"}" | jq -r .id)

G2=$(curl -sf -X POST $BASE/api/admin/goals \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d '{"title":"Runner Pizza Fund","description":"Keep the runners fed throughout the event","target_cents":25000,"is_active":true}' | jq -r .id)

G3=$(curl -sf -X POST $BASE/api/admin/goals \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d '{"title":"Charity Milestone — $5,000 Total","description":"Overall donation milestone for the event","target_cents":500000,"is_active":true}' | jq -r .id)

echo "   Goals: $G1 $G2 $G3"

# --- Donations (creates donors) ---
# Uses /api/admin/simulate-donation (rather than a raw webhook payload) so
# each donation can carry a channel_id, giving the admin dashboard's
# per-channel totals something to show. Alice/Dave donate to the Main
# Marathon, Bob/Carol to the Bonus Stream, Eve donates without a channel
# (simulating a legacy/direct donation not tied to either).
echo "==> Simulating donations..."
sim_donation() {
  local email=$1 name=$2 cents=$3 channel=$4
  local body
  if [ -n "$channel" ]; then
    body=$(printf '{"email":"%s","donor_name":"%s","amount_cents":%s,"channel_id":"%s"}' "$email" "$name" "$cents" "$channel")
  else
    body=$(printf '{"email":"%s","donor_name":"%s","amount_cents":%s}' "$email" "$name" "$cents")
  fi
  curl -sf -X POST $BASE/api/admin/simulate-donation \
    -H "Content-Type: application/json" -H "$AUTH" \
    -d "$body"
}

ALICE=$(sim_donation "alice@example.com" "Alice Speedrun" 10000 "$C_MAIN" | jq -r .token)
BOB=$(sim_donation "bob@example.com" "Bob Gamer" 6000 "$C_BONUS" | jq -r .token)
CAROL=$(sim_donation "carol@example.com" "Carol Plays" 3500 "$C_BONUS" | jq -r .token)
DAVE=$(sim_donation "dave@example.com" "Dave" 20000 "$C_MAIN" | jq -r .token)
EVE=$(sim_donation "eve@example.com" "Eve the Runner" 7500 "" | jq -r .token)
sim_donation "alice@example.com" "Alice Speedrun" 3000 "$C_MAIN" > /dev/null
echo "   6 donations created (Alice/Dave -> Main Marathon, Bob/Carol -> Bonus Stream, Eve -> no channel)."

# --- Reward claims ---
# Donor spend routes authenticate via `Authorization: Bearer <magic-token>`
# (the legacy ?token= query param is gone).
echo "==> Claiming rewards..."
curl -sf -X POST "$BASE/api/rewards/$R_SHOUT/claim" -H "Content-Type: application/json" -H "Authorization: Bearer $ALICE" \
  -d '{"claim_data":{"message":"Shoutout to my cat Mittens!"}}' > /dev/null
curl -sf -X POST "$BASE/api/rewards/$R_DISC/claim" -H "Content-Type: application/json" -H "Authorization: Bearer $ALICE" \
  -d '{"claim_data":{}}' > /dev/null
curl -sf -X POST "$BASE/api/rewards/$R_SHIRT/claim" -H "Content-Type: application/json" -H "Authorization: Bearer $DAVE" \
  -d '{"claim_data":{"name":"Dave Smith","address":"123 Main St","city":"Portland","country":"US"}}' > /dev/null
curl -sf -X POST "$BASE/api/rewards/$R_GAME/claim" -H "Content-Type: application/json" -H "Authorization: Bearer $DAVE" \
  -d '{"claim_data":{"your_game_pick":"Outer Wilds"}}' > /dev/null
curl -sf -X POST "$BASE/api/rewards/$R_SHOUT/claim" -H "Content-Type: application/json" -H "Authorization: Bearer $BOB" \
  -d '{"claim_data":{"message":"Bob was here!"}}' > /dev/null
echo "   5 claims created."

# --- Poll votes ---
echo "==> Voting on polls..."
curl -sf -X POST "$BASE/api/polls/$P1/vote" -H "Content-Type: application/json" -H "Authorization: Bearer $ALICE" -d "{\"poll_option_id\":\"$OPT_CELESTE\",\"amount_cents\":2000}" > /dev/null
curl -sf -X POST "$BASE/api/polls/$P1/vote" -H "Content-Type: application/json" -H "Authorization: Bearer $DAVE"  -d "{\"poll_option_id\":\"$OPT_HOLLOW\",\"amount_cents\":3000}" > /dev/null
curl -sf -X POST "$BASE/api/polls/$P1/vote" -H "Content-Type: application/json" -H "Authorization: Bearer $BOB"   -d "{\"poll_option_id\":\"$OPT_HADES\",\"amount_cents\":1500}" > /dev/null
curl -sf -X POST "$BASE/api/polls/$P1/vote" -H "Content-Type: application/json" -H "Authorization: Bearer $CAROL" -d "{\"poll_option_id\":\"$OPT_CELESTE\",\"amount_cents\":1000}" > /dev/null
curl -sf -X POST "$BASE/api/polls/$P1/vote" -H "Content-Type: application/json" -H "Authorization: Bearer $EVE"   -d "{\"poll_option_id\":\"$OPT_DISCO\",\"amount_cents\":2000}" > /dev/null
curl -sf -X POST "$BASE/api/polls/$P2/vote" -H "Content-Type: application/json" -H "Authorization: Bearer $DAVE"  -d "{\"poll_option_id\":\"$OPT_BLIND\",\"amount_cents\":5000}" > /dev/null
curl -sf -X POST "$BASE/api/polls/$P2/vote" -H "Content-Type: application/json" -H "Authorization: Bearer $ALICE" -d "{\"poll_option_id\":\"$OPT_DEV\",\"amount_cents\":2000}" > /dev/null
curl -sf -X POST "$BASE/api/polls/$P2/vote" -H "Content-Type: application/json" -H "Authorization: Bearer $EVE"   -d "{\"poll_option_id\":\"$OPT_RACE\",\"amount_cents\":2500}" > /dev/null
curl -sf -X POST "$BASE/api/polls/$P3/vote" -H "Content-Type: application/json" -H "Authorization: Bearer $CAROL" -d "{\"poll_option_id\":\"$OPT_NODEATH\",\"amount_cents\":1000}" > /dev/null
curl -sf -X POST "$BASE/api/polls/$P3/custom-entry" -H "Content-Type: application/json" -H "Authorization: Bearer $BOB" -d '{"label":"Bob'"'"'s underdog comeback moment","amount_cents":1500}' > /dev/null
echo "   9 votes cast (incl. 1 custom write-in on the shared poll)."

# --- Goal contributions ---
echo "==> Contributing to goals..."
curl -sf -X POST "$BASE/api/goals/$G1/contribute" -H "Content-Type: application/json" -H "Authorization: Bearer $DAVE"  -d '{"amount_cents":4000}' > /dev/null
curl -sf -X POST "$BASE/api/goals/$G1/contribute" -H "Content-Type: application/json" -H "Authorization: Bearer $ALICE" -d '{"amount_cents":2000}' > /dev/null
curl -sf -X POST "$BASE/api/goals/$G1/contribute" -H "Content-Type: application/json" -H "Authorization: Bearer $EVE"   -d '{"amount_cents":1500}' > /dev/null
curl -sf -X POST "$BASE/api/goals/$G2/contribute" -H "Content-Type: application/json" -H "Authorization: Bearer $BOB"   -d '{"amount_cents":2000}' > /dev/null
curl -sf -X POST "$BASE/api/goals/$G2/contribute" -H "Content-Type: application/json" -H "Authorization: Bearer $CAROL" -d '{"amount_cents":1000}' > /dev/null
curl -sf -X POST "$BASE/api/goals/$G3/contribute" -H "Content-Type: application/json" -H "Authorization: Bearer $ALICE" -d '{"amount_cents":2000}' > /dev/null
echo "   6 contributions made."

# --- Summary ---
echo ""
echo "==> Done. Summary:"
curl -sf $BASE/api/admin/stats -H "$AUTH" | jq .
echo ""
echo "Channels:     Main Marathon ($C_MAIN), Bonus Stream ($C_BONUS)"
echo "Rewards:      $R_SHOUT (shared), $R_DISC (shared), $R_SHIRT (Main), $R_GAME (Main) — all with test images"
echo "Auctions:     $A_SHARED (shared), $A_STREAM (Bonus) — all with test images, no bids (needs verified-email donor)"
echo "Polls:        $P1 (Main), $P2 (Bonus), $P3 (shared)"
echo "Goals:        $G1 (Bonus), $G2 (shared), $G3 (shared)"
echo "Alice wallet: $CLIENT/api/auth/magic?token=$ALICE"
echo "Dave wallet:  $CLIENT/api/auth/magic?token=$DAVE"
echo "Admin panel:  $CLIENT/admin  (key: $KEY)"
