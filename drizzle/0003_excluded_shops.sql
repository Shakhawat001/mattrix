CREATE TABLE "excluded_shops" (
	"shop" text PRIMARY KEY NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
