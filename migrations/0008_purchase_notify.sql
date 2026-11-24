-- Run once:  npx wrangler d1 execute voltaic-db --remote --file=migrations/0008_purchase_notify.sql

ALTER TABLE purchases ADD COLUMN notified_at INTEGER;
