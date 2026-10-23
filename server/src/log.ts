const emit = (level: string) => (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

export const log = { info: emit("info"), warn: emit("warn"), error: emit("error") };
