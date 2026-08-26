-- CreateTable
CREATE TABLE "Auction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "custom_type_label" TEXT,
    "image_url" TEXT,
    "starting_price_cents" INTEGER NOT NULL,
    "min_increment_cents" INTEGER NOT NULL,
    "current_bid_cents" INTEGER,
    "current_bidder_id" TEXT,
    "ends_at" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "current_offer_id" TEXT,
    "channel_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Auction_current_offer_id_fkey" FOREIGN KEY ("current_offer_id") REFERENCES "AuctionOffer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Auction_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "Channel" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Auction_current_bidder_id_fkey" FOREIGN KEY ("current_bidder_id") REFERENCES "Donor" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Bid" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auction_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "rank" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Bid_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "Auction" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Bid_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuctionOffer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auction_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "bid_id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "checkout_session_id" TEXT,
    "checkout_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "expires_at" DATETIME NOT NULL,
    "emailed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "AuctionOffer_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "Auction" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AuctionOffer_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuctionWin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auction_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "winning_bid_cents" INTEGER NOT NULL,
    "checkout_session_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'FULFILLED',
    "reversed_at" DATETIME,
    "reversed_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "AuctionWin_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "Auction" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AuctionWin_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "Donor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Auction_current_offer_id_key" ON "Auction"("current_offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionOffer_checkout_session_id_key" ON "AuctionOffer"("checkout_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionWin_auction_id_key" ON "AuctionWin"("auction_id");

-- RedefineIndex
DROP INDEX "Event_name_key";
CREATE UNIQUE INDEX "Channel_name_key" ON "Channel"("name");
