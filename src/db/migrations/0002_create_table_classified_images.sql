CREATE TABLE "classified_images" (
	"classified_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"average_hash" text,
	"difference_hash" text,
	"perceptual_hash" text,
	CONSTRAINT "classified_images_classified_id_id_pk" PRIMARY KEY("classified_id","id")
);
--> statement-breakpoint
ALTER TABLE "classified_images" ADD CONSTRAINT "classified_images_classified_id_classifieds_id_fk" FOREIGN KEY ("classified_id") REFERENCES "public"."classifieds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "classified_images_classified_position_uniq" ON "classified_images" USING btree ("classified_id","position");--> statement-breakpoint
CREATE INDEX "classified_images_classified_position_idx" ON "classified_images" USING btree ("classified_id","position");
