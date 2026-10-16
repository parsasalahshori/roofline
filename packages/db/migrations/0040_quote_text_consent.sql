ALTER TABLE "quote_requests" ADD COLUMN "text_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD COLUMN "text_consent_text" text;