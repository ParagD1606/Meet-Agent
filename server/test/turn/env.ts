process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.DATABASE_URL = process.env.DATABASE_URL?.includes("5433") ? process.env.DATABASE_URL : "postgres://brain@localhost:5433/brain";
