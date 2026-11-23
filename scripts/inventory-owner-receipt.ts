import { parseArgs } from "node:util";
import { Client, type ClientConfig } from "pg";
import { readPrivateText } from "./oci-files.ts";

/** Use a dedicated recorder login and apply TLS settings independently of the URL. */
function recorderConnection(value: string): ClientConfig {
  const url = new URL(value.trim());
  if (
    url.protocol !== "postgresql:" ||
    url.username !== "berth_inventory_submitter" ||
    !url.password ||
    url.pathname !== "/neondb" ||
    !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) ||
    (url.port && url.port !== "5432") ||
    url.hash ||
    [...url.searchParams].some(
      ([key, option]) =>
        url.searchParams.getAll(key).length !== 1 ||
        !(
          (key === "sslmode" &&
            (option === "require" || option === "verify-full")) ||
          (key === "channel_binding" && option === "require")
        ),
    )
  )
    throw Error("Invalid recorder connection");
  return {
    host: url.hostname,
    database: "neondb",
    user: url.username,
    password: decodeURIComponent(url.password),
    port: 5432,
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: true,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    statement_timeout: 3000,
  };
}

/** Submit one reviewed private receipt. Never retry across an uncertain SQL acknowledgement. */
async function main() {
  const { values } = parseArgs({
    options: {
      "database-url-file": { type: "string" },
      "receipt-file": { type: "string" },
    },
  });
  if (!values["database-url-file"] || !values["receipt-file"])
    throw Error("Expected two private file paths");
  const receipt = await readPrivateText(values["receipt-file"]);
  if (Buffer.byteLength(receipt) > 8192) throw Error("Invalid receipt size");
  JSON.parse(receipt);
  const db = new Client(
    recorderConnection(await readPrivateText(values["database-url-file"])),
  );
  try {
    await db.connect();
    const { rows } = await db.query(
      "SELECT berth_inventory.submit_owner_receipt($1::jsonb) AS result",
      [receipt],
    );
    const result = rows[0]?.result;
    if (
      result !== "recorded" &&
      result !== "already-recorded" &&
      result !== "conflict"
    )
      throw Error("Invalid evidence result");
    console.log(JSON.stringify({ result }));
    if (result === "conflict") process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch(() => {
  console.error(
    "Inventory receipt submission stopped. Preserve the private receipt and reconcile before retrying. Only use --database-url-file and --receipt-file with private file paths.",
  );
  process.exitCode = 1;
});
