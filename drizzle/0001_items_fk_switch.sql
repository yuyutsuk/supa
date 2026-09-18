ALTER TABLE "items" DROP CONSTRAINT IF EXISTS "items_user_id_app_users_fkey";
--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT IF EXISTS "items_user_id_user_fkey";
--> statement-breakpoint
ALTER TABLE "items"
ADD CONSTRAINT "items_user_id_user_fkey"
FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
ON DELETE CASCADE
NOT VALID;
