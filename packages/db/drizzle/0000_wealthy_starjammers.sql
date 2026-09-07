CREATE TYPE "public"."card_lifecycle_status" AS ENUM('ordered', 'issued', 'active', 'frozen', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."invoice_payment_state" AS ENUM('draft', 'issued', 'paid', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."spend_limit_reset_period" AS ENUM('monthly', 'quarterly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."transaction_settlement_state" AS ENUM('authorised', 'settled', 'reversed', 'disputed');--> statement-breakpoint
CREATE TABLE "api_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"client_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"contract_version" text NOT NULL,
	"response_status_code" smallint NOT NULL,
	"consumer_package_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pan_last_four" char(4) NOT NULL,
	"lifecycle_status" "card_lifecycle_status" NOT NULL,
	"activated_at" timestamp with time zone,
	"art_asset_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registered_legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"organisation_number" varchar(11) NOT NULL,
	"default_currency_code" char(3) NOT NULL,
	CONSTRAINT "companies_organisation_number_unique" UNIQUE("organisation_number")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"due_on" date NOT NULL,
	"total_minor_units" integer NOT NULL,
	"currency_code" char(3) NOT NULL,
	"payment_state" "invoice_payment_state" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_limits" (
	"card_id" uuid NOT NULL,
	"cap_minor_units" integer NOT NULL,
	"reset_period" "spend_limit_reset_period" NOT NULL,
	"period_started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "spend_limits_card_id_reset_period_period_started_at_pk" PRIMARY KEY("card_id","reset_period","period_started_at")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"booked_at" timestamp with time zone NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"currency_code" char(3) NOT NULL,
	"merchant_name" text NOT NULL,
	"merchant_category_code" char(4) NOT NULL,
	"settlement_state" "transaction_settlement_state" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_limits" ADD CONSTRAINT "spend_limits_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_usage_client_id_occurred_at_idx" ON "api_usage" USING btree ("client_id","occurred_at");--> statement-breakpoint
CREATE INDEX "api_usage_occurred_at_idx" ON "api_usage" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "invoices_company_id_due_on_idx" ON "invoices" USING btree ("company_id","due_on");--> statement-breakpoint
CREATE INDEX "transactions_company_id_booked_at_idx" ON "transactions" USING btree ("company_id","booked_at");