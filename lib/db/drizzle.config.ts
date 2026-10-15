import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.SQLITE_PATH || !path.isAbsolute(process.env.SQLITE_PATH)) {
  throw new Error("SQLITE_PATH must be an absolute file path");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.SQLITE_PATH,
  },
});
