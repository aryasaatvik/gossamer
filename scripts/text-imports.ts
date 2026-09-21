import { readFileSync } from "node:fs";

const importedText = /\/src\/(?:cli\/preset|workflows\/prompts)\/.*\.(?:md|txt|jsonc)$/;

/** Inline source-owned text imports for Vite tests and the published CLI bundle. */
export const textImports = () => ({
  name: "pagegraph-text-imports",
  load(id: string) {
    const path = id.split("?", 1)[0] ?? id;
    if (!importedText.test(path)) return null;
    return `export default ${JSON.stringify(readFileSync(path, "utf8"))};`;
  },
});
