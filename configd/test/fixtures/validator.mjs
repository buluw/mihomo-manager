import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const marker = args.shift();
const configIndex = args.indexOf("-f");
const content = await readFile(args[configIndex + 1], "utf8");
if (content.includes("TIMEOUT")) {
  process.on("SIGTERM", async () => {
    if (marker !== "-") await writeFile(marker, "terminated");
    process.exit(2);
  });
  setInterval(() => {}, 1000);
} else {
  process.exit(content.includes("INVALID") ? 1 : 0);
}
