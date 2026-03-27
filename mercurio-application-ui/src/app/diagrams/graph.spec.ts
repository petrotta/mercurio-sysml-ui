import type { ProjectModelView, SymbolView } from "../contracts.js";
import type { DiagramDocument } from "./file.js";
import { buildDiagramGraph, mergeDiagramNodePositions, resolvePreferredDiagramRoot } from "./graph.js";
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

function assertOk(value: unknown, label: string): void {
  if (!value) {
    fail(`${label}: expected truthy value`);
  }
}

const projectSymbols: SymbolView[] = [
  {
    symbol_id: "pkg-vehicle",
    name: "VehiclePkg",
    kind: "Package",
    metatype_qname: "SysML::Package",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "VehiclePkg",
    parent_qualified_name: null,
    file: 1,
    start_line: 1,
    start_col: 1,
    end_line: 20,
    end_col: 1,
    properties: [],
    relationships: [{ kind: "Import", target: "PowerPkg", resolved_target: "PowerPkg", start_line: 1, start_col: 1, end_line: 1, end_col: 10 }],
  },
  {
    symbol_id: "pkg-power",
    name: "PowerPkg",
    kind: "Package",
    metatype_qname: "SysML::Package",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "PowerPkg",
    parent_qualified_name: "VehiclePkg",
    file: 1,
    start_line: 21,
    start_col: 1,
    end_line: 40,
    end_col: 1,
    properties: [],
    relationships: [],
  },
  {
    symbol_id: "vehicle",
    name: "Vehicle",
    kind: "PartDefinition",
    metatype_qname: "SysML::PartDefinition",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "Vehicle",
    parent_qualified_name: "VehiclePkg",
    file: 1,
    start_line: 41,
    start_col: 1,
    end_line: 80,
    end_col: 1,
    properties: [],
    relationships: [],
  },
  {
    symbol_id: "engine",
    name: "Engine",
    kind: "PartDefinition",
    metatype_qname: "SysML::PartDefinition",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "Engine",
    parent_qualified_name: "Vehicle",
    file: 1,
    start_line: 81,
    start_col: 1,
    end_line: 100,
    end_col: 1,
    properties: [],
    relationships: [],
  },
];

const projectModel: ProjectModelView = {
  stdlib_path: null,
  workspace_snapshot_hit: false,
  project_cache_hit: false,
  element_count: 4,
  elements: [
    {
      name: "VehiclePkg",
      qualified_name: "VehiclePkg",
      kind: "Package",
      file_path: "model.sysml",
      start_line: 1,
      start_col: 1,
      end_line: 20,
      end_col: 1,
      metatype_qname: "SysML::Package",
      declared_supertypes: [],
      supertypes: [],
      direct_specializations: [],
      indirect_specializations: [],
      documentation: null,
      attributes: [],
      diagnostics: [],
    },
    {
      name: "PowerPkg",
      qualified_name: "PowerPkg",
      kind: "Package",
      file_path: "model.sysml",
      start_line: 21,
      start_col: 1,
      end_line: 40,
      end_col: 1,
      metatype_qname: "SysML::Package",
      declared_supertypes: [],
      supertypes: [],
      direct_specializations: [],
      indirect_specializations: [],
      documentation: null,
      attributes: [],
      diagnostics: [],
    },
    {
      name: "Vehicle",
      qualified_name: "Vehicle",
      kind: "PartDefinition",
      file_path: "model.sysml",
      start_line: 41,
      start_col: 1,
      end_line: 80,
      end_col: 1,
      metatype_qname: "SysML::PartDefinition",
      declared_supertypes: [],
      supertypes: [],
      direct_specializations: [],
      indirect_specializations: [],
      documentation: null,
      attributes: [{ name: "mass", qualified_name: "Vehicle::mass", declared_type: "Mass", multiplicity: "1", direction: null, documentation: null, cst_value: null, metamodel_attribute_qname: null, diagnostics: [] }],
      diagnostics: [],
    },
    {
      name: "Engine",
      qualified_name: "Engine",
      kind: "PartDefinition",
      file_path: "model.sysml",
      start_line: 81,
      start_col: 1,
      end_line: 100,
      end_col: 1,
      metatype_qname: "SysML::PartDefinition",
      declared_supertypes: ["Vehicle"],
      supertypes: ["Vehicle"],
      direct_specializations: [],
      indirect_specializations: [],
      documentation: null,
      attributes: [],
      diagnostics: [],
    },
  ],
  expressions: [],
  diagnostics: [],
};

const packageDiagram: DiagramDocument = {
  version: 1,
  name: "Packages",
  diagram_type: DIAGRAM_TYPES.Package,
  root_element_qualified_name: "Vehicle",
  root_file_path: "model.sysml",
  node_positions: { VehiclePkg: { x: 200, y: 80 } },
};

const resolvedPackageRoot = resolvePreferredDiagramRoot(DIAGRAM_TYPES.Package, projectSymbols[2]!, projectSymbols);
assertEqual(resolvedPackageRoot?.qualified_name, "VehiclePkg", "package root falls back to nearest package");

const packageGraph = buildDiagramGraph(packageDiagram, projectModel, projectSymbols);
assertEqual(packageGraph.unresolvedRoot, false, "package graph resolves");
assertEqual(packageGraph.rootQualifiedName, "VehiclePkg", "package graph root");
assertEqual(packageGraph.nodes.length, 2, "package graph node count");
assertEqual(packageGraph.edges.some((edge) => edge.kind === "relationship"), true, "package graph relationship edge");

const packagePositions = mergeDiagramNodePositions(packageGraph, packageDiagram.node_positions);
assertDeepEqual(packagePositions.VehiclePkg, { x: 200, y: 80 }, "preserve saved package root position");
assertOk(packagePositions.PowerPkg, "auto-place new package node");

const bddDiagram: DiagramDocument = {
  version: 1,
  name: "BDD",
  diagram_type: DIAGRAM_TYPES.Bdd,
  root_element_qualified_name: "Vehicle",
  root_file_path: "model.sysml",
  node_positions: {},
};
const bddGraph = buildDiagramGraph(bddDiagram, projectModel, projectSymbols);
assertEqual(bddGraph.unresolvedRoot, false, "bdd graph resolves");
assertEqual(bddGraph.nodes.length, 2, "bdd graph node count");
assertEqual(bddGraph.edges.some((edge) => edge.kind === "generalization"), true, "bdd graph generalization edge");

const unresolvedGraph = buildDiagramGraph({
  version: 1,
  name: "Missing",
  diagram_type: DIAGRAM_TYPES.Bdd,
  root_element_qualified_name: "Missing",
  root_file_path: null,
}, projectModel, projectSymbols);
assertEqual(unresolvedGraph.unresolvedRoot, true, "missing root yields unresolved graph");

const metadataPreferredSymbols: SymbolView[] = [
  {
    symbol_id: "meta-package",
    name: "MetaPkg",
    kind: "Namespace",
    semantic_kind: "Package",
    structural_metatype_qname: "SysML::Package",
    classification_qname: "Parts::Package",
    metatype_qname: "Parts::Package",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "MetaPkg",
    parent_qualified_name: null,
    file: 1,
    start_line: 1,
    start_col: 1,
    end_line: 10,
    end_col: 1,
    properties: [],
    relationships: [],
  },
  {
    symbol_id: "meta-child",
    name: "Wheel",
    kind: "Element",
    semantic_kind: "PartDefinition",
    structural_metatype_qname: "SysML::PartDefinition",
    classification_qname: "Parts::Part",
    metatype_qname: "Parts::Part",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "MetaPkg::Wheel",
    parent_qualified_name: "MetaPkg",
    file: 1,
    start_line: 11,
    start_col: 1,
    end_line: 20,
    end_col: 1,
    properties: [],
    relationships: [],
  },
];

const metadataPreferredRoot = resolvePreferredDiagramRoot(
  DIAGRAM_TYPES.Package,
  metadataPreferredSymbols[1]!,
  metadataPreferredSymbols,
);
assertEqual(metadataPreferredRoot?.qualified_name, "MetaPkg", "package root prefers semantic metadata contract");
