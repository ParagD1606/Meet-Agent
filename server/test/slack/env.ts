// Imported first by helpers.ts: config.ts parses process.env at import time, so this must run before any src/ module.
process.env.DATABASE_URL ??= "postgres://brain@localhost:5433/brain";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.SLACK_SIGNING_SECRET ??= "test-signing-secret";
process.env.SLACK_CLIENT_ID ??= "cid";
process.env.SLACK_CLIENT_SECRET ??= "csecret";
