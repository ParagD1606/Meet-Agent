import { customType } from "drizzle-orm/pg-core";
import { config } from "../../config";

export const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => `vector(${config.EMBEDDING_DIM})`,
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => JSON.parse(v),
});

export const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
