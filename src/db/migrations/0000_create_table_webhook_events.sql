CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_ip" text,
	"payload" jsonb,
	"body_sha256" text NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_received_at_id_idx" ON "webhook_events" USING btree ("received_at","id");--> statement-breakpoint
CREATE INDEX "webhook_events_event_type_idx" ON "webhook_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "webhook_events_received_at_event_type_idx" ON "webhook_events" USING btree ("received_at","event_type");
