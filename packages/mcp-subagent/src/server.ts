import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawnSubAgent, SubAgentDepthExceededError } from "@loopeng/agents";

// This process is spawned per-session by the `claude` CLI (via --mcp-config,
// see buildSubAgentMcpConfig in @loopeng/agents) — one instance per running
// agent, not shared across runs. All the context it needs about the run that
// spawned it travels in via env vars set on that spawn, rather than an IPC
// call back to the API process. Card 438646e5: this process has no database
// credential of its own (scoped or otherwise) — spawn_sub_agent and get_doc
// both talk to the API over CARD_API_URL/CARD_API_KEY, the same
// single-run-scoped credential the top-level run itself gets, so every
// mutation and read this process makes is authenticated and auditable the
// same way any other card action is.
interface SubAgentEnvContext {
  parentAgentRunId: string;
  cardId: string | null;
  worktreeId: string | null;
  cwd: string;
  depth: number;
  disallowedTools: string[] | undefined;
  cardApiKey: string;
  cardApiUrl: string;
}

function readEnvContext(): SubAgentEnvContext {
  const parentAgentRunId = process.env.LOOPENG_PARENT_AGENT_RUN_ID;
  const cwd = process.env.LOOPENG_CWD;
  const cardApiKey = process.env.CARD_API_KEY;
  const cardApiUrl = process.env.CARD_API_URL;
  if (!parentAgentRunId || !cwd || !cardApiKey || !cardApiUrl) {
    throw new Error(
      "mcp-subagent server missing required LOOPENG_PARENT_AGENT_RUN_ID / LOOPENG_CWD / CARD_API_KEY / CARD_API_URL env vars — was it launched outside buildSubAgentMcpConfig?",
    );
  }
  const disallowedTools = process.env.LOOPENG_DISALLOWED_TOOLS?.split(",").filter(Boolean);
  return {
    parentAgentRunId,
    cwd,
    cardId: process.env.LOOPENG_CARD_ID || null,
    worktreeId: process.env.LOOPENG_WORKTREE_ID || null,
    depth: Number(process.env.LOOPENG_DELEGATION_DEPTH ?? "0"),
    disallowedTools: disallowedTools?.length ? disallowedTools : undefined,
    cardApiKey,
    cardApiUrl,
  };
}

// Read-only, so a plain unauthenticated GET (same as the web app's own doc
// reads) rather than needing the bearer token -- but routed through the API
// like everything else here rather than a direct DB+git read, so this
// process never needs any credential beyond CARD_API_KEY.
async function fetchDoc(apiUrl: string, slug: string): Promise<{ title: string; docType: string; status: string; body: string } | null> {
  const res = await fetch(`${apiUrl}/docs/${encodeURIComponent(slug)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get_doc: failed to fetch doc "${slug}" (${res.status}): ${await res.text()}`);
  return (await res.json()) as { title: string; docType: string; status: string; body: string };
}

// Mutating (creates a doc + a card link), so this one needs the bearer
// token like spawn_sub_agent -- routed through POST /cards/:id/adr-docs
// (requireActor + requireOwnCard server-side) instead of this process
// calling createDoc/db.insert(cardDocLinks) directly, for the same reason
// spawn_sub_agent/get_doc don't touch the DB either (card 438646e5).
async function createAdrDoc(
  apiUrl: string,
  apiKey: string,
  cardId: string,
  input: { slug: string; title: string; summary: string; content: string; tags: string[] },
): Promise<{ docId: string }> {
  const res = await fetch(`${apiUrl}/cards/${encodeURIComponent(cardId)}/adr-docs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`create_adr_doc: failed to create ADR (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as { docId: string };
}

const server = new McpServer({ name: "loopeng-subagent", version: "0.1.0" });

server.registerTool(
  "spawn_sub_agent",
  {
    description:
      "Delegate a focused, self-contained task to a fresh sub-agent running in the same worktree. " +
      "Blocks until the sub-agent finishes and returns its final result text so you can continue " +
      "your own reasoning with it. Delegation depth is capped — attempting to exceed it returns an error.",
    inputSchema: {
      task: z.string().min(1).describe("The specific, self-contained task for the sub-agent to complete."),
      context: z.string().default("").describe("Relevant background/context the sub-agent needs to complete the task."),
    },
  },
  async ({ task, context }) => {
    try {
      const ctx = readEnvContext();
      const result = await spawnSubAgent({
        parentAgentRunId: ctx.parentAgentRunId,
        cardId: ctx.cardId,
        worktreeId: ctx.worktreeId,
        cwd: ctx.cwd,
        depth: ctx.depth,
        disallowedTools: ctx.disallowedTools,
        task,
        context: context ?? "",
        cardApiKey: ctx.cardApiKey,
        cardApiUrl: ctx.cardApiUrl,
      });
      return {
        isError: result.isError,
        content: [{ type: "text" as const, text: result.resultText }],
      };
    } catch (err) {
      if (err instanceof SubAgentDepthExceededError) {
        return { isError: true, content: [{ type: "text" as const, text: err.message }] };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text" as const, text: `spawn_sub_agent failed: ${message}` }] };
    }
  },
);

server.registerTool(
  "get_doc",
  {
    description:
      "Fetch the full text of a doc-engine doc (spec/ADR/RFC/skill/wiki) by slug. Prompts only " +
      "inline a one-line summary per linked doc to stay small — call this when a summary suggests " +
      "the full doc has detail you actually need for the task at hand.",
    inputSchema: {
      slug: z.string().min(1).describe("The doc's slug, exactly as shown next to its summary in the prompt."),
    },
  },
  async ({ slug }) => {
    try {
      const ctx = readEnvContext();
      const doc = await fetchDoc(ctx.cardApiUrl, slug);
      if (!doc) {
        return { isError: true, content: [{ type: "text" as const, text: `get_doc: no doc found for slug "${slug}"` }] };
      }
      const text = [`# ${doc.title}`, `(${doc.docType}, status: ${doc.status})`, "", doc.body].join("\n");
      return { isError: false, content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text" as const, text: `get_doc failed: ${message}` }] };
    }
  },
);

server.registerTool(
  "create_adr_doc",
  {
    description:
      "Create an Architecture Decision Record (ADR) doc for the current card and link it (linkType=adr). " +
      "Use this once, as part of your normal work, on any card that touches architecture -- the adr_required " +
      "gate blocks such cards from merging until an accepted ADR is linked. The ADR is created at " +
      "status='proposed', not 'accepted': a human reviews and accepts it afterwards via the docs UI, so you " +
      "don't need (and cannot) accept it yourself in this run.",
    inputSchema: {
      slug: z.string().min(1).describe("Kebab-case slug for the ADR doc, unique across all docs (e.g. 'per-project-repo-resolution')."),
      title: z.string().min(1).describe("Human-readable ADR title."),
      summary: z
        .string()
        .min(1)
        .max(200)
        .describe("One-line summary (no newlines) — shown next to this doc's slug in future agent prompts instead of the full body."),
      content: z
        .string()
        .min(1)
        .describe("Full ADR body in markdown, e.g. Context / Decision / Consequences / Alternatives Considered sections."),
      tags: z.array(z.string()).default([]),
    },
  },
  async ({ slug, title, summary, content, tags }) => {
    try {
      const ctx = readEnvContext();
      if (!ctx.cardId) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "create_adr_doc: no card is associated with this agent run, nothing to link the ADR to" }],
        };
      }
      await createAdrDoc(ctx.cardApiUrl, ctx.cardApiKey, ctx.cardId, { slug, title, summary, content, tags });
      return {
        isError: false,
        content: [
          { type: "text" as const, text: `Created ADR "${title}" (slug: ${slug}, status: proposed) and linked it to this card as linkType=adr.` },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text" as const, text: `create_adr_doc failed: ${message}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
