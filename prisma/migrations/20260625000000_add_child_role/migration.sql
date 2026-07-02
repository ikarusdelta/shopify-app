-- v2 bundle model: mark a product as a child (one viewer menu) and record which menu.
ALTER TABLE "ProductConfig" ADD COLUMN "isChild" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProductConfig" ADD COLUMN "menuId" TEXT NOT NULL DEFAULT '';
