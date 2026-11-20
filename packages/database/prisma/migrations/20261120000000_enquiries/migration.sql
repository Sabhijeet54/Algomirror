-- Enquiries from the public company website (client / partner forms).
CREATE TYPE "EnquiryKind" AS ENUM ('CLIENT', 'PARTNER');
CREATE TYPE "EnquiryStatus" AS ENUM ('NEW', 'CONTACTED', 'CLOSED');

CREATE TABLE "Enquiry" (
    "id" TEXT NOT NULL,
    "kind" "EnquiryKind" NOT NULL,
    "status" "EnquiryStatus" NOT NULL DEFAULT 'NEW',
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "company" TEXT,
    "city" TEXT,
    "interest" TEXT NOT NULL,
    "details" JSONB,
    "message" TEXT,
    "note" TEXT,
    "page" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Enquiry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Enquiry_kind_createdAt_idx" ON "Enquiry"("kind", "createdAt");
CREATE INDEX "Enquiry_status_idx" ON "Enquiry"("status");
