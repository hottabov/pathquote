-- CreateEnum
CREATE TYPE "SigningStatus" AS ENUM ('NOT_SENT', 'SENT', 'VIEWED', 'SIGNED', 'DECLINED');

-- CreateEnum
CREATE TYPE "SignerRole" AS ENUM ('AUTHOR', 'CLIENT');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "signatureUrl" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "signedPdfName" TEXT,
ADD COLUMN     "signedPdfSha256" TEXT,
ADD COLUMN     "signingStatus" "SigningStatus" NOT NULL DEFAULT 'NOT_SENT';

-- CreateTable
CREATE TABLE "Signature" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "role" "SignerRole" NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "signerEmail" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SigningRequest" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "contactId" TEXT,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstViewedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "declineIp" TEXT,
    "declineUserAgent" TEXT,

    CONSTRAINT "SigningRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Signature_documentId_role_key" ON "Signature"("documentId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "SigningRequest_tokenHash_key" ON "SigningRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "SigningRequest_documentId_idx" ON "SigningRequest"("documentId");

-- AddForeignKey
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The archived signed PDF is a pair: a filename and the digest of those exact
-- bytes. One without the other is not a weaker record, it is a broken one --
-- a name with no digest proves nothing, a digest with no file verifies
-- nothing. Enforced here rather than in the action layer because the pair is
-- written once, at completion, and never edited afterwards.
ALTER TABLE "Document" ADD CONSTRAINT "Document_signed_pdf_pair"
  CHECK (("signedPdfName" IS NULL) = ("signedPdfSha256" IS NULL));

-- A signed quote is always a final one. canUnfinalize (src/lib/signing/state.ts)
-- refuses to reopen a SIGNED document and canSendToClient refuses to send a
-- DRAFT, so the application can only reach this pairing through a bug -- which
-- is exactly the case worth catching at the boundary that cannot be bypassed.
ALTER TABLE "Document" ADD CONSTRAINT "Document_signed_implies_final"
  CHECK ("signingStatus" <> 'SIGNED' OR "status" = 'FINAL');
