export interface QueryContext {
  dialect: string; database?: string; schema?: string; searchPath?: string[];
  connectionId?: string; consoleId?: string; documentId?: string; modelVersion?: number;
  contextKnown?: boolean; contextRevision?: number;
}
export interface CompletionRequest extends QueryContext { sql: string; cursor: number }
export interface TextEdit { from: number; to: number; text: string }
export interface EditPlan extends TextEdit {
  additionalEdits?: TextEdit[]; snippet?: string;
  documentId?: string; expectedModelVersion?: number; expectedCatalogRevision?: number;
}
export interface CompletionCandidate {
  id: string; kind: string; label: string; detail: string; doc: string;
  insertText: string; filterText: string | string[]; sortText: string;
  reason: string; source: string; confidence: 'verified' | 'inferred'; editPlan: EditPlan;
  scoreBreakdown: { semantic: number; match: number; nameMatch: boolean; pinned: number; learned: number };
  presentation?: { type: string; description: string };
  nonInsert?: boolean;
  resolve?: { kind: 'templateColumns'; table: { name: string; database?: string; schema?: string; type?: string } };
  metadataDependencies?: Array<{ name: string; database?: string; schema?: string; type?: string; temporary?: boolean; mode: 'identity' | 'structure' }>;
}
export interface CatalogColumn { name: string; type?: string; comment?: string; pk?: boolean; generated?: boolean; hidden?: boolean; invisible?: boolean }
export interface CatalogTable { name: string; database?: string; schema?: string; type?: string; state?: string; columns?: CatalogColumn[]; foreignKeys?: unknown[] }
export interface CompletionResponse {
  items: CompletionCandidate[]; replace: { from: number; to: number }; isIncomplete: boolean;
  context: Record<string, unknown>; requiredTables: unknown[]; diagnostics: unknown[];
}
