process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.DATABASE_URL ??= "postgres://brain:brain@localhost:5432/brain";
