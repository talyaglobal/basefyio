-- CreateEnum
CREATE TYPE "MarketingCampaignStatus" AS ENUM ('DRAFT', 'GENERATING', 'READY', 'PUBLISHING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "MarketingAssetKind" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO');

-- CreateEnum
CREATE TYPE "MarketingAssetStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "marketing_campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'instagram',
    "integration_id" TEXT,
    "status" "MarketingCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "language" TEXT NOT NULL DEFAULT 'en',
    "tone" TEXT,
    "caption" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "image_prompt" TEXT,
    "video_prompt" TEXT,
    "voice_script" TEXT,
    "pubbler_post_id" TEXT,
    "publish_mode" TEXT,
    "published_at" TIMESTAMP(3),
    "error" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_asset" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "kind" "MarketingAssetKind" NOT NULL,
    "status" "MarketingAssetStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "prompt" TEXT,
    "url" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketing_campaign_status_idx" ON "marketing_campaign"("status");

-- CreateIndex
CREATE INDEX "marketing_campaign_created_at_idx" ON "marketing_campaign"("created_at");

-- CreateIndex
CREATE INDEX "marketing_asset_campaign_id_idx" ON "marketing_asset"("campaign_id");

-- AddForeignKey
ALTER TABLE "marketing_asset" ADD CONSTRAINT "marketing_asset_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
