CREATE TABLE "aggregator_default_audit" (
	"change_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding" text NOT NULL,
	"from_org_id" text,
	"to_org_id" text,
	"changed_by" text NOT NULL,
	"changed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_for_bindings" text[];--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "onboarded_by_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "aggregator_default_audit_binding_idx" ON "aggregator_default_audit" USING btree ("binding","changed_at");--> statement-breakpoint
CREATE INDEX "aggregator_default_audit_to_org_idx" ON "aggregator_default_audit" USING btree ("to_org_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_single_default_idx" ON "organization" USING btree ((true)) WHERE "organization"."default_for_bindings" IS NOT NULL AND cardinality("organization"."default_for_bindings") > 0;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_default_requires_aggregator" CHECK ("organization"."default_for_bindings" IS NULL OR "organization"."type" = 'aggregator');