import { err, messageOf, ok, type Result } from "../../platform/result.ts";

// The addresses the owner added in the dashboard (D-40), in the registry's
// `email_addresses`. Whether each is confirmed is Cloudflare's own record,
// read by the caller; this table only says the owner added it.

/** Every added address, oldest first. */
export async function listAddedAddresses(db: D1Database): Promise<Result<string[]>> {
  try {
    const rows = await db
      .prepare("SELECT address FROM email_addresses ORDER BY added_at, address")
      .all<{ address: string }>();
    return ok(rows.results.map((row) => row.address));
  } catch (cause) {
    return err(messageOf(cause));
  }
}

/** Adds the address; adding one already there changes nothing. */
export async function addAddress(
  db: D1Database,
  address: string,
  now: number,
): Promise<Result<void>> {
  try {
    await db
      .prepare("INSERT OR IGNORE INTO email_addresses (address, added_at) VALUES (?, ?)")
      .bind(address, now)
      .run();
    return ok(undefined);
  } catch (cause) {
    return err(messageOf(cause));
  }
}

/** Removes the address from the list; true when it was there. */
export async function removeAddress(db: D1Database, address: string): Promise<Result<boolean>> {
  try {
    const result = await db
      .prepare("DELETE FROM email_addresses WHERE address = ?")
      .bind(address)
      .run();
    return ok(result.meta.changes > 0);
  } catch (cause) {
    return err(messageOf(cause));
  }
}
