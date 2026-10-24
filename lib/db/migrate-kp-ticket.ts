import { ensureKpTicketSchema, pool } from "./src/index";

ensureKpTicketSchema().then(() => {
  console.info("KP ticket tables are ready; existing balances and products were not changed.");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => pool.end());
