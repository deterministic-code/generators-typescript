import { readFile } from "node:fs/promises";

const resource = (rel: string): Promise<string> =>
  readFile(
    new URL(`../templates/create-shaped-types/${rel}`, import.meta.url),
    "utf8",
  );

export const [typeTmpl, indexTmpl] = await Promise.all([
  resource("type.ts.tmpl"),
  resource("index.ts.tmpl"),
]);
