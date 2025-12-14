CREATE TABLE "classified_price_history" (
	"classified_id" uuid NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"value" integer NOT NULL,
	CONSTRAINT "classified_price_history_classified_id_timestamp_pk" PRIMARY KEY("classified_id","timestamp")
);
--> statement-breakpoint
ALTER TABLE "classified_price_history" ADD CONSTRAINT "classified_price_history_classified_id_classifieds_id_fk" FOREIGN KEY ("classified_id") REFERENCES "public"."classifieds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "classified_price_history_classified_timestamp_idx" ON "classified_price_history" USING btree ("classified_id","timestamp");
