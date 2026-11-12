import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { OciSetupError } from "./oci-access.js";
export async function readPrivateText(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new OciSetupError("Use an absolute private file path");
  const rel = relative(await realpath(process.cwd()), await realpath(path));
  if (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  ) {
    throw new OciSetupError(
      "Keep OCI configuration and credentials outside the repository",
    );
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 16384
    ) {
      throw new OciSetupError(
        "Expected a small owner-only private file (chmod 600)",
      );
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
