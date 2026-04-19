export type Approach =
  | "raw_vector"
  | "progressive_summary"
  | "hierarchical"
  | "typed_facts"
  | "spo_supersede";

export type MemoryLevel = 0 | 1 | 2;

export type LensName =
  | "archivist"
  | "empath"
  | "cartographer"
  | "timekeeper"
  | "librarian"
  | "composed";

export type EmpathKind =
  | "preference"
  | "goal"
  | "commitment"
  | "aversion"
  | "mood"
  | "fact";

export interface Turn {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export interface Memory {
  id?: bigint;
  approach: Approach;
  agent_id: string;
  level: MemoryLevel;
  content: string;
  event_time: Date;
  importance: number;
  entities: string[];
  parent_id?: bigint | null;
  embedding?: number[];
  lens?: LensName;
  subject?: string | null;
  predicate?: string | null;
  object?: string | null;
  valence?: number | null;
  kind?: EmpathKind | null;
  topic?: string | null;
  superseded_at?: Date | null;
  supersedes_id?: bigint | null;
}

export interface RetrievalResult {
  memory: Memory;
  score: number;
  components?: {
    vector?: number;
    fulltext?: number;
    importance?: number;
    recency?: number;
    temporal_match?: boolean;
    entity_match?: boolean;
  };
}

export interface WriteExtraction {
  importance: number;
  event_time: string; // ISO
  entities: string[];
  atomic_facts: string[]; // zero or more; empty = no extractable facts
}

// ---------- Five-lens extraction shapes ----------

export interface ArchivistFact {
  content: string; // atomic, pronouns resolved, self-contained
  importance: number; // 0..1
  confidence: number; // 0..1
}

export interface EmpathFact {
  content: string;
  kind: EmpathKind;
  valence: number; // -1..1
  importance: number; // 0..1
}

export interface CartographerTriple {
  subject: string; // lowercase, canonical
  predicate: string; // lowercase, snake_case
  object: string; // lowercase
  content: string; // "subject predicate object" rendered as a sentence
  importance: number;
}

export interface TimekeeperAnchor {
  content: string; // the statement this anchor applies to
  event_time: string; // ISO
  precision: "day" | "week" | "month" | "approximate";
  anchor_phrase: string; // "last Tuesday", "after the move", etc.
}

export interface LibrarianTag {
  content: string; // the statement being tagged
  topic: string; // short tag, e.g. "pets", "career", "relationships"
  novelty: "new" | "reinforces" | "updates" | "contradicts";
  // If updates/contradicts, the librarian proposes which prior memory to supersede.
  // The composer makes the final call.
  may_supersede_content?: string;
}

export interface LensBundle {
  archivist: ArchivistFact[];
  empath: EmpathFact[];
  cartographer: CartographerTriple[];
  timekeeper: TimekeeperAnchor[];
  librarian: LibrarianTag[];
}

export interface ComposedRow {
  content: string;
  lens: LensName;
  level: MemoryLevel;
  importance: number;
  event_time: string; // ISO
  entities: string[];
  kind?: EmpathKind | null;
  valence?: number | null;
  subject?: string | null;
  predicate?: string | null;
  object?: string | null;
  topic?: string | null;
  supersedes_id?: number | null; // DB id of the prior row (if any)
}

export interface ComposerPlan {
  commits: ComposedRow[];
  supersede_ids: number[]; // rows to mark superseded_at
}
