const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "src");
const allowList = new Set([
  path.normalize(path.join(root, "app", "services", "semanticApi.ts")),
]);

const bannedPatterns = [
  "core.query_semantic@v1",
  "core.get_project_model@v1",
  "core.get_project_element_attributes@v1",
  "core.get_stdlib_metamodel@v1",
];

const violations = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
    const normalized = path.normalize(full);
    if (allowList.has(normalized)) continue;
    const text = fs.readFileSync(full, "utf8");
    for (const pattern of bannedPatterns) {
      if (text.includes(pattern)) {
        violations.push({ file: normalized, pattern });
      }
    }
  }
}

walk(root);

if (violations.length) {
  console.error("Semantic authority check failed. Direct semantic tool usage must stay in semanticApi.ts.");
  for (const v of violations) {
    console.error(`- ${v.file}: ${v.pattern}`);
  }
  process.exit(1);
}

console.log("Semantic authority check passed.");

