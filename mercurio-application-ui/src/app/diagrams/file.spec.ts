import {
  buildDiagramFileName,
  createDiagramDocument,
  parseDiagramDocument,
  prepareDiagramDocumentForSave,
  serializeDiagramDocument,
} from "./file.js";
import { DIAGRAM_TYPES } from "./model.js";

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    fail(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    fail(`${label}: expected ${expectedJson}, received ${actualJson}`);
  }
}

function assertThrows(run: () => void, pattern: RegExp, label: string): void {
  try {
    run();
  } catch (error) {
    if (pattern.test(String(error))) {
      return;
    }
    fail(`${label}: threw unexpected error ${String(error)}`);
  }
  fail(`${label}: expected function to throw`);
}

const created = createDiagramDocument({
  name: "Vehicle Context",
  diagramType: DIAGRAM_TYPES.Bdd,
  rootQualifiedName: "Vehicle",
  rootFilePath: "model.sysml",
  viewport: { x: 10, y: 20, zoom: 0.9 },
  nodePositions: {
    Vehicle: { x: 100, y: 120 },
    Engine: { x: 320, y: 260 },
  },
});

const roundTripped = parseDiagramDocument(serializeDiagramDocument(created));
assertEqual(roundTripped.name, "Vehicle Context", "round-trip name");
assertEqual(roundTripped.diagram_type, DIAGRAM_TYPES.Bdd, "round-trip diagram type");
assertEqual(roundTripped.root_element_qualified_name, "Vehicle", "round-trip root");
assertDeepEqual(roundTripped.viewport, { x: 10, y: 20, zoom: 0.9 }, "round-trip viewport");
assertDeepEqual(roundTripped.node_positions, {
  Engine: { x: 320, y: 260 },
  Vehicle: { x: 100, y: 120 },
}, "round-trip positions");

const prepared = prepareDiagramDocumentForSave(created, ["Vehicle"]);
assertDeepEqual(prepared.node_positions, {
  Vehicle: { x: 100, y: 120 },
}, "prepared positions prune stale nodes");

assertEqual(buildDiagramFileName("vehicle-context"), "vehicle-context.diagram", "build file name without suffix");
assertEqual(buildDiagramFileName("vehicle-context.diagram"), "vehicle-context.diagram", "build file name with suffix");

assertThrows(
  () => parseDiagramDocument("{\"version\":2}"),
  /Unsupported diagram document version/,
  "reject unsupported version",
);

const unresolvedRootDoc = parseDiagramDocument(JSON.stringify({
  version: 1,
  name: "Unresolved",
  diagram_type: "bdd",
  root_element_qualified_name: "Missing::Element",
  root_file_path: null,
}));
assertEqual(unresolvedRootDoc.root_element_qualified_name, "Missing::Element", "preserve unresolved root");
