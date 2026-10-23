process.env.DATABASE_URL = process.env.DATABASE_URL?.includes("5433") ? process.env.DATABASE_URL : "postgres://brain@localhost:5433/brain_a";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.DB_LOCK_POOL_MAX = "4"; // small on purpose: the pool-exhaustion regression needs holders > connections
process.env.DB_POOL_MAX = "4";
process.env.SLACK_SIGNING_SECRET ??= "test-signing-secret";
