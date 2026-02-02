const path = require("path");
const fs = require("fs");

const repoRoot = path.resolve(__dirname, "..");
const src = path.join(repoRoot, "node_modules", "monaco-editor", "min");
const dest = path.join(repoRoot, "public", "monaco");

const copyDir = (from, to) => {
  if (!fs.existsSync(from)) {
    console.error(`Monaco source not found: ${from}`);
    process.exit(1);
  }
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
};

try {
  copyDir(src, dest);
  console.log(`Monaco assets copied to ${dest}`);
} catch (err) {
  console.error("Failed to copy Monaco assets:", err);
  process.exit(1);
}
