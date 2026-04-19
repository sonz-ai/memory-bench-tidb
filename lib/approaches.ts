export interface TidbFeature {
  k: "vector" | "fts" | "structured" | "json" | "supersede";
  label: string;
}

export const TIDB_FEATURES: TidbFeature[] = [
  { k: "vector", label: "Vector (HNSW cosine)" },
  { k: "fts", label: "Full-text / LIKE" },
  { k: "structured", label: "Structured (scalar + temporal + level)" },
  { k: "json", label: "Indexed JSON (JSON_CONTAINS)" },
  { k: "supersede", label: "Composite SPO index + superseded_at" },
];

export interface FlowNode {
  label: string;
  em?: boolean;
  par?: { label: string }[];
}

export interface SampleRow {
  content: string;
  filled: string[];
  level?: string;
  importance?: string;
  entities?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  lens?: string;
  topic?: string;
  kind?: string;
  valence?: string;
  superseded?: boolean;
}

export interface Approach {
  id: string;
  tag: string;
  flow: {
    prose: string;
    nodes: FlowNode[];
  };
  rows: SampleRow[];
  tidb: TidbFeature["k"][];
  isolates: {
    delta: string;
    text: string;
  };
}

export const APPROACHES: Approach[] = [
  {
    id: "raw_vector",
    tag: "control",
    flow: {
      prose:
        "Embed every message, insert it. No LLM at write, no reasoning. Basic RAG — the floor every other approach has to clear.",
      nodes: [
        { label: "turn" },
        { label: "embed" },
        { label: "INSERT", em: true },
      ],
    },
    rows: [
      {
        content:
          "Okay so my golden Max is about to turn 3 next month — remind me to book the vet.",
        filled: ["content", "embedding"],
      },
      {
        content: "moved to Tokyo last spring for work, apartment in Shibuya",
        filled: ["content", "embedding"],
      },
      {
        content: "actually the meeting is Thursday not Wednesday, sorry",
        filled: ["content", "embedding"],
      },
    ],
    tidb: ["vector"],
    isolates: {
      delta: "adds · nothing (control)",
      text: "The control. Zero LLM at write. Pure cosine retrieval at read. Every other approach's write-time compute is paid against this floor.",
    },
  },
  {
    id: "progressive_summary",
    tag: "compression",
    flow: {
      prose:
        "Every 5 messages, one LLM call compresses the window into a summary row. Retrieval runs cosine over summaries — fewer, denser rows than raw_vector.",
      nodes: [
        { label: "turn" },
        { label: "buffer · 5" },
        { label: "LLM summarize" },
        { label: "embed" },
        { label: "INSERT level=2", em: true },
      ],
    },
    rows: [
      {
        content:
          "Window 1–5: user owns golden retriever Max (~3y). Discussed vet booking and Thursday meeting reschedule.",
        filled: ["content", "level", "embedding"],
        level: "2",
      },
      {
        content:
          "Window 6–10: user relocated to Tokyo/Shibuya for work. Apartment setup, area vet search.",
        filled: ["content", "level", "embedding"],
        level: "2",
      },
      {
        content:
          "Window 11–15: scheduling conflicts, standup moved to Thursdays.",
        filled: ["content", "level", "embedding"],
        level: "2",
      },
    ],
    tidb: ["vector", "structured"],
    isolates: {
      delta: "adds · write-time compression",
      text: "Adds compression on top of raw_vector. Summaries replace raw messages in the index. Tests whether denser summary rows retrieve better than a larger pool of raw turns.",
    },
  },
  {
    id: "hierarchical",
    tag: "multi-level",
    flow: {
      prose:
        "Keep the last 20 messages verbatim (level=0). Older messages get compressed in 10-turn batches (level=2). Retrieval looks at both layers.",
      nodes: [
        { label: "turn" },
        {
          label: "par",
          par: [
            { label: "recent 20 · level=0" },
            { label: "older · batch 10 · level=2" },
          ],
        },
        { label: "embed" },
        { label: "INSERT", em: true },
      ],
    },
    rows: [
      {
        content:
          "Okay so my golden Max is about to turn 3 next month — remind me to book the vet.",
        filled: ["content", "level", "embedding"],
        level: "0",
      },
      {
        content: "actually the meeting is Thursday not Wednesday, sorry",
        filled: ["content", "level", "embedding"],
        level: "0",
      },
      {
        content:
          "Turns 21–30: moved to Tokyo, apartment in Shibuya, searching for local vet.",
        filled: ["content", "level", "embedding"],
        level: "2",
      },
    ],
    tidb: ["vector", "structured"],
    isolates: {
      delta: "adds · layering (recent verbatim + older summarized)",
      text: "Adds layering on top of progressive_summary. Recent context stays verbatim; only old context is compressed. Tests whether preserving recent wording beats uniform compression.",
    },
  },
  {
    id: "typed_facts",
    tag: "one call · typed",
    flow: {
      prose:
        "The first write-heavy approach. One LLM call per message extracts structured fields: how important is this (0..1), when the event actually happened, who or what is mentioned, and the atomic facts stated. The retriever then fuses vector, lexical match, importance, recency, temporal window, and JSON entity — all in one ORDER BY.",
      nodes: [
        { label: "turn" },
        { label: "LLM extract" },
        {
          label: "par",
          par: [
            { label: "importance" },
            { label: "event_time" },
            { label: "entities (json)" },
            { label: "facts" },
          ],
        },
        { label: "embed" },
        { label: "INSERT", em: true },
      ],
    },
    rows: [
      {
        content: "User owns a golden retriever named Max, ~3 years old.",
        filled: [
          "content",
          "importance",
          "event_time",
          "entities",
          "embedding",
        ],
        importance: "0.74",
        entities: "['max','dog']",
      },
      {
        content: "User relocated San Francisco → Tokyo (Shibuya), spring 2025.",
        filled: [
          "content",
          "importance",
          "event_time",
          "entities",
          "embedding",
        ],
        importance: "0.91",
        entities: "['sf','tokyo','shibuya']",
      },
      {
        content: "Meeting moved Wednesday → Thursday 14:00 UTC.",
        filled: [
          "content",
          "importance",
          "event_time",
          "entities",
          "embedding",
        ],
        importance: "0.38",
        entities: "['meeting']",
      },
    ],
    tidb: ["vector", "fts", "structured", "json"],
    isolates: {
      delta: "adds · LLM-scored fields + temporal anchoring",
      text: "The first write-heavy approach. Adds LLM-scored importance, event_time, and JSON entities on top of hierarchical. Tests whether write-time scoring and temporal/entity signals fused in one ORDER BY beat cosine-only retrieval.",
    },
  },
  {
    id: "spo_supersede",
    tag: "two lenses · supersede",
    flow: {
      prose:
        "Two small LLMs run in parallel on each message. The Cartographer pulls out relationship triples like (user, owns_dog, Max) and writes them into indexed subject/predicate/object columns. The Librarian compares the message against what's already in memory and flags updates or contradictions. Then a deterministic rule takes over: same (subject, predicate) → UPDATE the old row SET superseded_at = NOW(). No LLM on the reconcile path.",
      nodes: [
        { label: "turn" },
        {
          label: "par",
          par: [
            { label: "Cartographer · SPO" },
            { label: "Librarian · novelty" },
          ],
        },
        { label: "deterministic merge", em: true },
        { label: "INSERT + UPDATE supersede" },
      ],
    },
    rows: [
      {
        content: "User owns a golden retriever named Max, ~3y old.",
        filled: [
          "content",
          "subject",
          "predicate",
          "object",
          "lens",
          "importance",
          "entities",
          "embedding",
        ],
        subject: "'user'",
        predicate: "'owns_pet'",
        object: "'max:golden_retriever'",
        lens: "'cartographer'",
      },
      {
        content: "User lives in Tokyo (Shibuya).",
        filled: [
          "content",
          "subject",
          "predicate",
          "object",
          "lens",
          "importance",
          "entities",
          "embedding",
        ],
        subject: "'user'",
        predicate: "'lives_in'",
        object: "'tokyo'",
        lens: "'cartographer'",
      },
      {
        content: "User lives in San Francisco.",
        filled: [
          "content",
          "subject",
          "predicate",
          "object",
          "lens",
          "embedding",
          "superseded_at",
        ],
        subject: "'user'",
        predicate: "'lives_in'",
        object: "'sf'",
        lens: "'cartographer'",
        superseded: true,
      },
      {
        content: "Novelty: first mention of Tokyo move.",
        filled: ["content", "lens", "topic", "kind", "valence", "embedding"],
        lens: "'librarian'",
        topic: "'relocation'",
        kind: "'novel'",
        valence: "'+'",
      },
    ],
    tidb: ["vector", "fts", "structured", "json", "supersede"],
    isolates: {
      delta: "adds · SPO extraction + deterministic supersede",
      text: "Adds SPO extraction and deterministic supersede on top of typed_facts. Two parallel LLMs, then code — not a third LLM — decides what retires. Tests whether write-time contradiction resolution earns its cost: every contradiction collapsed here is an LLM reconciliation avoided at read.",
    },
  },
];
