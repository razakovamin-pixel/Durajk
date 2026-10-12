import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
if (scripts.length !== 1) throw new Error(`Expected one inline script, found ${scripts.length}`);
new Script(scripts[0][1], { filename: "public/index.html:inline-script" });

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
const seen = new Set();
for (const id of ids) {
  if (seen.has(id)) throw new Error(`Duplicate HTML id: ${id}`);
  seen.add(id);
}
const references = [...scripts[0][1].matchAll(/\$\(["']([^"']+)["']\)/g)].map((match) => match[1]);
const missing = [...new Set(references.filter((id) => !seen.has(id)))];
if (missing.length) throw new Error(`JavaScript references missing HTML IDs: ${missing.join(", ")}`);
console.log(`Client syntax OK; ${ids.length} unique HTML IDs; all ${new Set(references).size} static ID references exist.`);
