import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { resolveStateDir } from "../../config/paths.js";
import { jsonResult, readStringParam, readNumberParam, ToolInputError } from "./common.js";
import type { AnyAgentTool } from "./common.js";

const WIKI_ACTIONS = ["search", "read", "index"] as const;
type WikiAction = (typeof WIKI_ACTIONS)[number];

const MAX_READ_BYTES = 100_000;
const DEFAULT_MAX_RESULTS = 20;
const MAX_SNIPPET_CHARS = 500;
const MAX_DEPTH = 3;

const WikiToolSchema = Type.Object({
  op: Type.Union(WIKI_ACTIONS.map((a) => Type.Literal(a))),
  query: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.Optional(Type.String({ minLength: 1 })),
  maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
  lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  from: Type.Optional(Type.Number({ minimum: 0 })),
});

export const WIKI_TOOL_DISPLAY_SUMMARY = "Search and read structured knowledge base (wiki) files.";

function resolveWikiDirs(): string[] {
  const dirs: string[] = [];
  const home = process.env.OPENCLAW_HOME?.trim() || process.env.OPENCLAW_STATE_DIR?.trim();
  const stateDir = home || resolveStateDir();
  const base = path.join(stateDir, "wiki");
  if (fs.existsSync(base)) {
    dirs.push(base);
  }
  // Also support workspace-level wiki
  const workspace = process.env.OPENCLAW_WORKSPACE_DIR?.trim();
  if (workspace) {
    const wsWiki = path.join(workspace, "wiki");
    if (fs.existsSync(wsWiki)) {
      dirs.push(wsWiki);
    }
  }
  return dirs;
}

function collectMarkdownFiles(dir: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  const entries: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        entries.push(...collectMarkdownFiles(full, depth + 1));
      } else if (entry.isFile() && /\.(md|mdx|txt)$/i.test(entry.name)) {
        entries.push(full);
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return entries;
}

function excerpt(content: string, query: string, maxChars: number): string {
  const lower = content.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return content.slice(0, maxChars);
  const start = Math.max(0, idx - Math.floor(maxChars / 3));
  const end = Math.min(content.length, start + maxChars);
  let snippet = content.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < content.length) snippet += "…";
  return snippet;
}

export function createWikiTool(): AnyAgentTool {
  return {
    name: "wiki",
    description: [
      "Search and read a structured knowledge base (wiki) of markdown files.",
      "",
      "Operations:",
      "- search: Grep for a query across all wiki files, returns matching excerpts",
      "- read: Read a specific wiki page by relative path",
      "- index: List all available wiki pages with titles",
      "",
      "Wiki files live in ~/.openclaw/wiki/ or <workspace>/wiki/.",
      "Use for project docs, runbooks, architecture notes, and reference material.",
    ].join("\n"),
    parameters: WikiToolSchema,
    displaySummary: WIKI_TOOL_DISPLAY_SUMMARY,
    execute: async (_toolCallId, params): Promise<unknown> => {
      const op = readStringParam(params, "op") as WikiAction;

      const dirs = resolveWikiDirs();
      if (dirs.length === 0) {
        return jsonResult({
          error:
            "No wiki directories found. Create ~/.openclaw/wiki/ or <workspace>/wiki/ with markdown files.",
        });
      }

      switch (op) {
        case "index": {
          const pages: Array<{ path: string; title: string; size: number }> = [];
          for (const dir of dirs) {
            const files = collectMarkdownFiles(dir);
            for (const file of files) {
              const rel = path.relative(dir, file);
              try {
                const stat = fs.statSync(file);
                const content = fs.readFileSync(file, "utf-8");
                // Extract title from first # heading or filename
                const titleMatch = content.match(/^#\s+(.+)$/m);
                const title = titleMatch?.[1]?.trim() || path.basename(file, path.extname(file));
                pages.push({ path: rel, title, size: stat.size });
              } catch {
                pages.push({ path: rel, title: path.basename(file), size: 0 });
              }
            }
          }
          pages.sort((a, b) => a.path.localeCompare(b.path));
          return jsonResult({ pages, total: pages.length });
        }

        case "search": {
          const query = readStringParam(params, "query", { required: true });
          const maxResults = readNumberParam(params, "maxResults") ?? DEFAULT_MAX_RESULTS;
          const results: Array<{ path: string; title: string; snippet: string; matches: number }> =
            [];

          for (const dir of dirs) {
            const files = collectMarkdownFiles(dir);
            for (const file of files) {
              const rel = path.relative(dir, file);
              try {
                const content = fs.readFileSync(file, "utf-8");
                const lower = content.toLowerCase();
                const qLower = query.toLowerCase();

                // Count matches
                let matches = 0;
                let pos = 0;
                while ((pos = lower.indexOf(qLower, pos)) !== -1) {
                  matches++;
                  pos += 1;
                }

                if (matches > 0) {
                  const titleMatch = content.match(/^#\s+(.+)$/m);
                  const title = titleMatch?.[1]?.trim() || path.basename(file, path.extname(file));
                  const snippet = excerpt(content, query, MAX_SNIPPET_CHARS);
                  results.push({ path: rel, title, snippet, matches });
                }
              } catch {
                // skip unreadable files
              }
            }
          }

          results.sort((a, b) => b.matches - a.matches);
          const limited = results.slice(0, maxResults);
          return jsonResult({
            query,
            results: limited,
            total: results.length,
            shown: limited.length,
          });
        }

        case "read": {
          const filePath = readStringParam(params, "path", { required: true });
          const fromLine = readNumberParam(params, "from") ?? 0;
          const maxLines = readNumberParam(params, "lines") ?? 200;

          // Prevent path traversal
          const normalized = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
          if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
            return jsonResult({ error: "Invalid path: must be relative within wiki directory" });
          }

          for (const dir of dirs) {
            const full = path.join(dir, normalized);
            try {
              const stat = fs.statSync(full);
              if (!stat.isFile()) continue;
              if (stat.size > MAX_READ_BYTES) {
                return jsonResult({
                  error: `File too large (${stat.size} bytes, max ${MAX_READ_BYTES})`,
                });
              }
              const content = fs.readFileSync(full, "utf-8");
              const lines = content.split("\n");
              const start = Math.max(0, fromLine);
              const end = Math.min(lines.length, start + maxLines);
              const slice = lines.slice(start, end).join("\n");
              return jsonResult({
                path: normalized,
                content: slice,
                totalLines: lines.length,
                shownLines: end - start,
                fromLine: start,
              });
            } catch {
              continue;
            }
          }

          return jsonResult({ error: `Wiki page not found: ${normalized}` });
        }

        default:
          throw new ToolInputError(`Unknown wiki operation: ${op}`);
      }
    },
  };
}
