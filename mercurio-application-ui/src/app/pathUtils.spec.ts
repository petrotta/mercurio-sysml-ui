import { isPathWithin, normalizeFsPath } from "./pathUtils.js";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function run() {
  assert(normalizeFsPath("C:\\A\\B\\") === "c:/a/b", "normalizes windows separators and trailing slash");
  assert(normalizeFsPath("/A//B///") === "/a/b", "normalizes repeated slashes");
  assert(isPathWithin("C:\\Repo\\stdlib\\KerML.kerml", "c:/repo/stdlib"), "matches mixed slash and case");
  assert(!isPathWithin("C:\\Repo\\stdlib2\\KerML.kerml", "c:/repo/stdlib"), "enforces folder boundary");
  assert(isPathWithin("/repo/stdlib", "/repo/stdlib"), "matches exact root");
}

run();
