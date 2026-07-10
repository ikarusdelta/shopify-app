-- Add viewer org/directory ids to ProductConfig (sent in the order-attribution payload).
ALTER TABLE "ProductConfig" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ProductConfig" ADD COLUMN "dirId" TEXT NOT NULL DEFAULT '';
