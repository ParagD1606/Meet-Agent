import { embed } from "../../src/memory/embed";
import { completeText } from "../../src/memory/llm";
import { check, finish, setup, q } from "./harness";

await setup();
check("chat", /ok/i.test(await completeText({ system: "Reply with the single word ok", prompt: "ping", role: "extract" })));
const [v] = await embed(["hello"]);
check("embed dims", v?.length === Number(process.env.EMBEDDING_DIM ?? 1536), String(v?.length));
check("cast", (await q("select count(*)::int n from users"))[0].n === 7);
finish("smoke");
