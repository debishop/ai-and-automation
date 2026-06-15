---
name: para-memory-files
description: >
  File-based memory system using Tiago Forte's PARA method. Use this skill whenever
  you need to store, retrieve, update, or organize knowledge across sessions. Covers
  four memory layers: (0) Role work-log for bounded operational continuity per task,
  (1) Knowledge graph in PARA folders with atomic YAML facts,
  (2) Daily notes as raw timeline, (3) Tacit knowledge about user patterns. Also
  handles planning files, memory decay, weekly synthesis, and recall via qmd.
  Trigger on any memory operation: saving facts, writing daily notes, creating
  entities, running weekly synthesis, recalling past context, or managing plans.
---

# PARA Memory Files

Persistent, file-based memory organized by Tiago Forte's PARA method. Four layers: a role work-log, a knowledge graph, daily notes, and tacit knowledge. All paths are relative to `$AGENT_HOME`.

## Layer 0 — Role Work-Log (`$AGENT_HOME/memory.md` + `archive.md`) **[mandatory for all agents]**

A bounded, append-only work-log that gives every agent compact memory of their own operational history. This is **not** a knowledge graph — it records _what you did_ and _standing constraints_, not domain facts.

### Per-task contract (required)

**Task start:** run `agent-memory read` to load your ROLLING SUMMARY + last 10 log entries into context.

**Task end:** run `agent-memory append` (pipe one structured entry via stdin/heredoc) to record what was done.

```bash
# task start
agent-memory read

# task end — pipe one structured entry; the CLI stamps today's date
agent-memory append <<'EOF'
Topic/Work → Field1 · Field2 · Field3 · Handoff
EOF
```

### File format

```
<Role> — Memory
<!-- READ: ROLLING SUMMARY + last 10 RECENT LOG entries only. Never read archive.md. -->

## ROLLING SUMMARY
- <role-specific summary fields>

---

## RECENT LOG
<!-- Append-only. Newest at bottom. >40 entries triggers auto-compact. -->
[YYYY-MM-DD] — <structured entry per role template>
```

**Read path:** ROLLING SUMMARY + last N (default 10) entries. Never load the full file or `archive.md`.

**Write path:** exactly one structured entry appended per completed task, using `agent-memory append`.

**Compaction:** when RECENT LOG > 40 entries, `agent-memory append` auto-runs the mechanical half — oldest `(count−10)` entries move to `archive.md`, a `<!-- SUMMARY-UPDATE-NEEDED -->` marker is inserted. The agent then folds the emitted entries into ROLLING SUMMARY and removes the marker.

### CLI reference (`agent-memory`)

Installed at `/usr/local/bin/agent-memory` via the base image (source: `tools/agent-memory/`). Operates on `$AGENT_HOME/memory.md` + `$AGENT_HOME/archive.md`.

| Subcommand | Effect |
|---|---|
| `read [--n N]` | Print ROLLING SUMMARY + last N entries (default 10) |
| `append` | Read one entry from stdin, stamp date, append; auto-compact if >40 |
| `compact` | Mechanical archive move; emit archived entries to stdout for ROLLING SUMMARY update |
| `init <role>` | Seed `memory.md` from role template if absent (idempotent) |
| `version` | Print CLI version |

### Per-role entry templates

| Role | ROLLING SUMMARY fields | RECENT LOG entry format |
|---|---|---|
| **Content Researcher** | Pillars covered · topics done · topics in-progress · reliable sources · unreliable sources · known gaps · editorial constraints | `[date] — Topic → Pillar · Done · Key sources · Verdict on sourcing · Open threads · Handoff` |
| **Editorial Writer** | Pieces published · active drafts+stage · voice/style rules · recurring structures · do-not-repeat angles · standing constraints | `[date] — Piece → Pillar · Stage · Word count/format · Source brief · Fact-Check status · Open edits · Handoff` |
| **Fact-Checker** | Claims verified count · disputed facts · trusted/rejected sources · recurring error patterns · sensitivity flags | `[date] — Item → Claims checked · Verdict (verified/corrected/rejected) · Sources · Corrections · Unresolved · Handoff` |
| **Video & Media Producer** | Assets/series produced · templates locked · platform specs · b-roll/music refs · rejected formats · visual constraints | `[date] — Asset → Piece it supports · Format/platform · Status · Assets used · Approvals · Open threads · Handoff` |
| **CMO** | Strategy+pillars · channel highlights · brand/editorial policy · pending approvals · cross-team blockers | `[date] — Decision/Review → Area · Decision · Driver/metric · Affected roles · Open threads · Handoff` |
| **CCO** | Content strategy+pillars · channel highlights · editorial/brand policy · pending approvals · cross-team blockers | `[date] — Decision/Review → Area · Decision · Driver/metric · Affected roles · Open threads · Handoff` |
| **CEO** | Company goals+status · standing directives · open board items · delegations in flight | `[date] — Directive/Review → Area · Decision · Rationale · Owner · Open threads` |
| **CTO** | Systems owned+status · infra decisions · credential locations (never values) · failure modes · delegations in flight | `[date] — Work → System · Change/decision · Verified live? · Delegated to · Risk/rollback · Open threads` |
| **Engineer** | Systems owned · technical decisions · integration IDs/locations · failure modes · delegations | `[date] — Work → System · Change/decision · Tests passing? · PR/commit · Risk/rollback · Open threads` |

All 9 roles are covered by `agent-memory init <role>`: Content Researcher, Editorial Writer, Fact-Checker, Video & Media Producer, CMO, CCO, CEO, CTO, Engineer. CMO and CCO share the same marketing/comms schema.

**Note:** Only Fact-Checker may stamp entries `verified`.

### Backstop compaction routine

A weekly CTO-owned `memory-compaction` routine wakes any agent whose `memory.md` carries a `SUMMARY-UPDATE-NEEDED` marker to complete the semantic fold into ROLLING SUMMARY.

---

## Layer 1: Knowledge Graph (`$AGENT_HOME/life/` -- PARA)

Entity-based storage. Each entity gets a folder with two tiers:

1. `summary.md` -- quick context, load first.
2. `items.yaml` -- atomic facts, load on demand.

```text
$AGENT_HOME/life/
  projects/          # Active work with clear goals/deadlines
    <name>/
      summary.md
      items.yaml
  areas/             # Ongoing responsibilities, no end date
    people/<name>/
    companies/<name>/
  resources/         # Reference material, topics of interest
    <topic>/
  archives/          # Inactive items from the other three
  index.md
```

**PARA rules:**

- **Projects** -- active work with a goal or deadline. Move to archives when complete.
- **Areas** -- ongoing (people, companies, responsibilities). No end date.
- **Resources** -- reference material, topics of interest.
- **Archives** -- inactive items from any category.

**Fact rules:**

- Save durable facts immediately to `items.yaml`.
- Weekly: rewrite `summary.md` from active facts.
- Never delete facts. Supersede instead (`status: superseded`, add `superseded_by`).
- When an entity goes inactive, move its folder to `$AGENT_HOME/life/archives/`.

**When to create an entity:**

- Mentioned 3+ times, OR
- Direct relationship to the user (family, coworker, partner, client), OR
- Significant project or company in the user's life.
- Otherwise, note it in daily notes.

For the atomic fact YAML schema and memory decay rules, see [references/schemas.md](references/schemas.md).

### Layer 2: Daily Notes (`$AGENT_HOME/memory/YYYY-MM-DD.md`)

Raw timeline of events -- the "when" layer.

- Write continuously during conversations.
- Extract durable facts to Layer 1 during heartbeats.

### Layer 3: Tacit Knowledge (`$AGENT_HOME/MEMORY.md`)

How the user operates -- patterns, preferences, lessons learned.

- Not facts about the world; facts about the user.
- Update whenever you learn new operating patterns.

## Write It Down -- No Mental Notes

Memory does not survive session restarts. Files do.

- Want to remember something -> WRITE IT TO A FILE.
- "Remember this" -> update `$AGENT_HOME/memory/YYYY-MM-DD.md` or the relevant entity file.
- Learn a lesson -> update AGENTS.md, TOOLS.md, or the relevant skill file.
- Make a mistake -> document it so future-you does not repeat it.
- On-disk text files are always better than holding it in temporary context.

## Memory Recall -- Use qmd

Use `qmd` rather than grepping files:

```bash
qmd query "what happened at Christmas"   # Semantic search with reranking
qmd search "specific phrase"              # BM25 keyword search
qmd vsearch "conceptual question"         # Pure vector similarity
```

Index your personal folder: `qmd index $AGENT_HOME`

Vectors + BM25 + reranking finds things even when the wording differs.

## Planning

Keep plans in timestamped files in `plans/` at the project root (outside personal memory so other agents can access them). Use `qmd` to search plans. Plans go stale -- if a newer plan exists, do not confuse yourself with an older version. If you notice staleness, update the file to note what it is supersededBy.
