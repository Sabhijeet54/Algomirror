-- TradingView / alert webhook: one secret token per strategy (null = webhook off).
ALTER TABLE "Strategy" ADD COLUMN IF NOT EXISTS "webhookToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Strategy_webhookToken_key" ON "Strategy"("webhookToken");
