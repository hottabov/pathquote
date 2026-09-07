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
    "contactId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstViewedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "declineIp" TEXT,

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
ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

