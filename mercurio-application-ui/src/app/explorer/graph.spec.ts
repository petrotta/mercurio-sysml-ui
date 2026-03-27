import type { ProjectModelView, SymbolView } from "../contracts.js";
import {
  buildExplorerGraph,
  canExpandExplorerNode,
  mergeExplorerNodePositions,
  resolvePreferredExplorerRoot,
} from "./graph.js";

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    fail(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertOk(value: unknown, label: string): void {
  if (!value) {
    fail(`${label}: expected truthy value`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    fail(`${label}: expected ${expectedJson}, received ${actualJson}`);
  }
}

const workspaceSymbols: SymbolView[] = [
  {
    symbol_id: "vehicle",
    name: "Vehicle",
    kind: "PartDefinition",
    metatype_qname: "SysML::PartDefinition",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "Vehicle",
    parent_qualified_name: null,
    file: 1,
    start_line: 1,
    start_col: 1,
    end_line: 20,
    end_col: 1,
    properties: [],
  },
  {
    symbol_id: "engine-usage",
    name: "engine",
    kind: "PartUsage",
    metatype_qname: "SysML::PartUsage",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "Vehicle::engine",
    parent_qualified_name: "Vehicle",
    file: 1,
    start_line: 3,
    start_col: 3,
    end_line: 3,
    end_col: 20,
    properties: [],
    structural_type: {
      feature_name: "type",
      label: "engine",
      target: "Engine",
      target_metatype_qname: "SysML::PartDefinition",
      declared_type_qname: "Engine",
      metamodel_feature_qname: "sysml::PartUsage::type",
    },
  },
  {
    symbol_id: "chassis",
    name: "Chassis",
    kind: "PartDefinition",
    metatype_qname: "SysML::PartDefinition",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "Vehicle::Chassis",
    parent_qualified_name: "Vehicle",
    file: 1,
    start_line: 5,
    start_col: 3,
    end_line: 9,
    end_col: 1,
    properties: [],
  },
  {
    symbol_id: "engine",
    name: "Engine",
    kind: "PartDefinition",
    metatype_qname: "SysML::PartDefinition",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "Engine",
    parent_qualified_name: null,
    file: 1,
    start_line: 22,
    start_col: 1,
    end_line: 30,
    end_col: 1,
    properties: [],
  },
  {
    symbol_id: "satisfy",
    name: "vehicleSatisfiesRequirement",
    kind: "Satisfy",
    metatype_qname: "SysML::Satisfy",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "Vehicle::vehicleSatisfiesRequirement",
    parent_qualified_name: "Vehicle",
    file: 1,
    start_line: 12,
    start_col: 3,
    end_line: 12,
    end_col: 35,
    properties: [],
    directed_relationships: [
      {
        canonical_kind: "satisfy",
        display_label: "satisfy",
        source: "Vehicle",
        target: "Requirement",
        target_metatype_qname: "SysML::RequirementDefinition",
        source_feature: null,
        target_feature: null,
        resolved: true,
      },
      {
        canonical_kind: "refine",
        display_label: "refine",
        source: "Vehicle",
        target: "RefinedRequirement",
        target_metatype_qname: "SysML::RequirementDefinition",
        source_feature: null,
        target_feature: null,
        resolved: false,
      },
    ],
    explorer_diagnostics: ["Could not normalize refine relationship"],
  },
  {
    symbol_id: "requirement",
    name: "Requirement",
    kind: "RequirementDefinition",
    metatype_qname: "SysML::RequirementDefinition",
    file_path: "requirements.sysml",
    source_scope: "project",
    qualified_name: "Requirement",
    parent_qualified_name: null,
    file: 2,
    start_line: 1,
    start_col: 1,
    end_line: 8,
    end_col: 1,
    properties: [],
  },
  {
    symbol_id: "machine",
    name: "Machine",
    kind: "PartDefinition",
    metatype_qname: "SysML::PartDefinition",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "Machine",
    parent_qualified_name: null,
    file: 1,
    start_line: 32,
    start_col: 1,
    end_line: 36,
    end_col: 1,
    properties: [],
  },
];

const projectModel: ProjectModelView = {
  stdlib_path: null,
  workspace_snapshot_hit: false,
  project_cache_hit: false,
  element_count: 5,
  elements: [
    {
      name: "Vehicle",
      qualified_name: "Vehicle",
      kind: "PartDefinition",
      file_path: "model.sysml",
      start_line: 1,
      start_col: 1,
      end_line: 20,
      end_col: 1,
      metatype_qname: "SysML::PartDefinition",
      declared_supertypes: [],
      supertypes: [],
      direct_specializations: [],
      indirect_specializations: [],
      documentation: "Top-level vehicle",
      attributes: [],
      diagnostics: [],
    },
    {
      name: "Engine",
      qualified_name: "Engine",
      kind: "PartDefinition",
      file_path: "model.sysml",
      start_line: 22,
      start_col: 1,
      end_line: 30,
      end_col: 1,
      metatype_qname: "SysML::PartDefinition",
      declared_supertypes: ["Machine"],
      supertypes: ["Machine"],
      direct_specializations: [],
      indirect_specializations: [],
      documentation: null,
      attributes: [{ name: "rpm", qualified_name: "Engine::rpm", declared_type: "Integer", multiplicity: "1", direction: null, documentation: null, cst_value: null, metamodel_attribute_qname: null, diagnostics: [] }],
      diagnostics: [],
    },
    {
      name: "Chassis",
      qualified_name: "Vehicle::Chassis",
      kind: "PartDefinition",
      file_path: "model.sysml",
      start_line: 5,
      start_col: 3,
      end_line: 9,
      end_col: 1,
      metatype_qname: "SysML::PartDefinition",
      declared_supertypes: [],
      supertypes: [],
      direct_specializations: [],
      indirect_specializations: [],
      documentation: null,
      attributes: [],
      diagnostics: [],
    },
    {
      name: "Requirement",
      qualified_name: "Requirement",
      kind: "RequirementDefinition",
      file_path: "requirements.sysml",
      start_line: 1,
      start_col: 1,
      end_line: 8,
      end_col: 1,
      metatype_qname: "SysML::RequirementDefinition",
      declared_supertypes: [],
      supertypes: [],
      direct_specializations: [],
      indirect_specializations: [],
      documentation: null,
      attributes: [],
      diagnostics: [],
    },
    {
      name: "Machine",
      qualified_name: "Machine",
      kind: "PartDefinition",
      file_path: "model.sysml",
      start_line: 32,
      start_col: 1,
      end_line: 36,
      end_col: 1,
      metatype_qname: "SysML::PartDefinition",
      declared_supertypes: [],
      supertypes: [],
      direct_specializations: ["Engine"],
      indirect_specializations: [],
      documentation: null,
      attributes: [],
      diagnostics: [],
    },
  ],
  expressions: [],
  diagnostics: [],
};

const preferredRoot = resolvePreferredExplorerRoot(workspaceSymbols[1]!, workspaceSymbols);
assertEqual(preferredRoot?.qualified_name, "Engine", "usage root resolves to typed definition");

const structuralGraph = buildExplorerGraph({
  rootQualifiedName: "Vehicle",
  showDirectedRelationships: false,
  workspaceSymbols,
  projectModel,
});

assertEqual(structuralGraph.unresolvedRoot, false, "structural graph resolves root");
assertEqual(structuralGraph.rootQualifiedName, "Vehicle", "structural graph root qname");
assertEqual(structuralGraph.nodes.some((node) => node.qualifiedName === "Vehicle::engine"), false, "usage nodes are collapsed");
assertOk(structuralGraph.nodes.some((node) => node.qualifiedName === "Engine"), "typed definition is included");
assertOk(structuralGraph.nodes.some((node) => node.qualifiedName === "Vehicle::Chassis"), "owned definition is included");
assertOk(structuralGraph.edges.some((edge) => edge.kind === "ownsDefinition" && edge.label === "engine" && edge.targetQualifiedName === "Engine"), "typed usage becomes labeled ownership edge");
assertOk(structuralGraph.edges.some((edge) => edge.kind === "specializes" && edge.sourceQualifiedName === "Engine" && edge.targetQualifiedName === "Machine"), "specialization edge is included");
assertEqual(structuralGraph.edges.some((edge) => edge.kind === "directedRelationship"), false, "directed relationships are hidden by default");

const structuralPositions = mergeExplorerNodePositions(structuralGraph, {
  Vehicle: { x: 120, y: 40 },
});
assertDeepEqual(structuralPositions.Vehicle, { x: 120, y: 40 }, "saved structural position is preserved");
assertOk(structuralPositions.Engine, "new structural nodes receive auto positions");

const directedGraph = buildExplorerGraph({
  rootQualifiedName: "Vehicle",
  expandedQualifiedNames: ["Vehicle"],
  showDirectedRelationships: true,
  workspaceSymbols,
  projectModel,
});

assertOk(directedGraph.edges.some((edge) => edge.kind === "directedRelationship" && edge.canonicalKind === "satisfy" && edge.sourceQualifiedName === "Vehicle" && edge.targetQualifiedName === "Requirement"), "directed relationship overlay adds satisfy edge");
assertOk(directedGraph.nodes.some((node) => node.qualifiedName === "Requirement" && node.relationOnly), "directed relationship target node is marked relation-only");
assertOk(directedGraph.diagnostics.some((diagnostic) => diagnostic.includes("Unresolved refine relationship on Vehicle::vehicleSatisfiesRequirement")), "unresolved directed relationships surface diagnostics");
assertOk(directedGraph.diagnostics.some((diagnostic) => diagnostic.includes("Could not normalize refine relationship")), "carrier diagnostics are preserved");

assertEqual(canExpandExplorerNode("Vehicle", workspaceSymbols), true, "definitions can expand");
assertEqual(canExpandExplorerNode("Vehicle::engine", workspaceSymbols), false, "usage nodes do not expand");

const metadataContractSymbols: SymbolView[] = [
  {
    symbol_id: "semantic-definition",
    name: "SemanticDefinition",
    kind: "Element",
    semantic_kind: "PartDefinition",
    structural_metatype_qname: "SysML::PartDefinition",
    classification_qname: "Parts::Part",
    metatype_qname: "Parts::Part",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "SemanticDefinition",
    parent_qualified_name: null,
    file: 1,
    start_line: 1,
    start_col: 1,
    end_line: 5,
    end_col: 1,
    properties: [],
  },
  {
    symbol_id: "semantic-usage",
    name: "semanticUsage",
    kind: "Element",
    semantic_kind: "PartUsage",
    structural_metatype_qname: "SysML::Usage",
    classification_qname: "Parts::Part",
    metatype_qname: "Parts::Part",
    file_path: "model.sysml",
    source_scope: "project",
    qualified_name: "Owner::semanticUsage",
    parent_qualified_name: "Owner",
    file: 1,
    start_line: 6,
    start_col: 1,
    end_line: 6,
    end_col: 20,
    properties: [],
    structural_type: {
      feature_name: "type",
      label: "semanticUsage",
      target: "SemanticDefinition",
      target_metatype_qname: "SysML::PartDefinition",
      declared_type_qname: "SemanticDefinition",
      metamodel_feature_qname: "sysml::Usage::type",
    },
  },
];

assertEqual(canExpandExplorerNode("SemanticDefinition", metadataContractSymbols), true, "semantic kind drives expandable definitions");
assertEqual(canExpandExplorerNode("Owner::semanticUsage", metadataContractSymbols), false, "semantic kind keeps usages collapsed");
assertEqual(
  resolvePreferredExplorerRoot(metadataContractSymbols[1]!, metadataContractSymbols)?.qualified_name,
  "SemanticDefinition",
  "usage root prefers semantic metadata contract",
);
