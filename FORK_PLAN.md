# OpenClaw Fork Plan

## Subagent Permission Fix ✅

**Problem:** Subagents couldn't read/write files due to restrictive tool allowlist.

**Root cause:** `tools.subagents.tools.allow` only included session management tools:

```json
{
  "allow": ["sessions_spawn", "sessions_list", "sessions_send", "sessions_history", "agents_list"]
}
```

**Fix:** Merged file I/O and web tools into the allowlist:

```json
{
  "allow": [
    "sessions_spawn",
    "sessions_list",
    "sessions_send",
    "sessions_history",
    "agents_list",
    "read",
    "write",
    "edit",
    "exec",
    "process",
    "web_search",
    "web_fetch",
    "browser",
    "image",
    "pdf",
    "memory_get",
    "memory_search"
  ]
}
```

**Note:** Can't use both `allow` and `alsoAllow` — schema validation rejects configs with both fields populated. Must merge into one.

**Status:** Config updated in `~/.openclaw/openclaw.json`. Gateway should accept on next reload.

---

## Stacks to Remove (Unused by Oat)

Based on current usage patterns, these extensions/apps can be removed to reduce bloat:

### High Priority (definitely unused)

| Category                  | Items                                                                                                                                                                                   | Reason                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Messaging channels**    | `feishu`, `line`, `mattermost`, `msteams`, `matrix`, `nextcloud-talk`, `nostr`, `qqbot`, `signal`, `slack`, `synology-chat`, `tlon`, `twitch`, `whatsapp`, `zalo`, `zalouser`, `wechat` | Only Telegram + Discord enabled            |
| **Voice/call**            | `azure-speech`, `deepgram`, `inworld`, `phone-control`, `senseaudio`, `talk-voice`, `voice-call`                                                                                        | Using `sag` (ElevenLabs) only              |
| **Video generation**      | `runway`, `video-generation-core`, `video-generation-providers.*`                                                                                                                       | Not used                                   |
| **Music generation**      | `comfy`, `music-generation-providers.*`                                                                                                                                                 | Not used                                   |
| **Enterprise SSO**        | `microsoft`, `microsoft-foundry`, `google-meet`                                                                                                                                         | Personal use, no enterprise integration    |
| **Chinese providers**     | `alibaba`, `baidu`, `qianfan`, `tencent`, `volcengine`, `xiaomi`, `zai`                                                                                                                 | Not in use                                 |
| **Niche model providers** | `arcee`, `cerebras`, `chutes`, `deepinfra`, `fireworks`, `gradium`, `kilocode`, `lmstudio`, `minimax`, `stepfun`, `together`, `tokenjuice`, `vllm`, `voyage`                            | Using Kimi/Genie/Gemini/Claude via LiteLLM |

### Medium Priority (maybe unused)

| Category                 | Items                                               | Notes                                     |
| ------------------------ | --------------------------------------------------- | ----------------------------------------- |
| **iOS/Android apps**     | `apps/android`, `apps/ios`                          | Using nodes, not sure if these are needed |
| **macOS-MLX-TTS**        | `apps/macos-mlx-tts`                                | Using ElevenLabs via `sag`                |
| **Specialized tools**    | `exa`, `firecrawl`, `tavily`                        | Using Brave search via `web_search`       |
| **Alternative browsers** | Multiple browser extensions                         | Using default OpenClaw browser            |
| **QA/testing**           | `qa-channel`, `qa-lab`, `qa-matrix`, `test-support` | Development tools, not runtime            |
| **Migration tools**      | `migrate-claude`, `migrate-hermes`                  | One-time migration, can remove            |

### Keep (actively used)

- `discord`, `telegram` — primary channels
- `elevenlabs` — via `sag` skill
- `browser` — web automation
- `github-copilot` — coding tasks
- `google`, `googlechat` — Google Workspace via `gog`
- `litellm` — model routing
- `ollama`, `openai`, `anthropic`, `google`, `moonshot` (Kimi), `groq` — model providers
- `webhooks`, `cron` — automation
- `memory-core`, `active-memory` — memory features
- `device-pair`, `bonjour` — node discovery
- `document-extract`, `web-readability` — content extraction
- `image-generation-core`, `fal` — image gen (maybe used)
- `speech-core`, `tts-local-cli` — TTS fallback

---

## First Features to Add (Priority Order)

### 1. Session Scratch Space (Medium complexity) — ✅ IMPLEMENTED

**Status:** Code complete, build passing, ready for migration.

**Files added:**

- `src/agents/tools/scratch-tool.ts` — tool definition (get/set/delete/list/clear)
- `src/sessions/scratch-store.ts` — SQLite-backed store with TTL support

**Files modified:**

- `src/agents/openclaw-tools.ts` — registered scratch tool
- `~/.openclaw/openclaw.json` — added scratch to subagent allow list

**Storage:** `~/.openclaw/scratch/scratch.db` (SQLite WAL mode)

**Limits:** 100 keys/session, 10KB/value, optional TTL

**Remaining:** Write unit tests (after migration)

---

### 2. Lightweight Heartbeat Peek — ❌ DROPPED (too risky)

**Decision:** The heartbeat system is 9,630 lines deeply entangled with sessions, channels, events, and the agent loop. A mandatory change here could break things in ways that only surface hours later. Not worth the risk for a personal fork.

**Alternative (no code changes):** Use scratch-based caching + conditional HEARTBEAT.md:

- Heartbeat writes results to `scratch` store with timestamps
- Next run checks freshness via `scratch.get()` before re-checking
- Use `heartbeat.model` config for a cheaper model
- Already 80% of the benefit with 0 risk

See `HEARTBEAT_REVIEW.md` for full architecture analysis.

### 3. Subagent Mid-Task Steering — ✅ ALREADY EXISTS

**Status:** OpenClaw already has `subagents` tool with `action: "steer"`. Sends message to running subagent, restarts it with new direction. Rate-limited (2s), max 4000 chars.

### 4. Lazy Context Loading — ✅ ALREADY IMPLEMENTED

**Status:** OpenClaw already has multi-layer caching:

1. File-level: inode/identity cache skips re-reading unchanged files
2. Bootstrap-level: content comparison reuses cached snapshot
3. API-level: Anthropic `cache_control: ephemeral` for system prompt blocks

The real optimization was reducing our workspace files (25KB → 11KB), done earlier today.

### 5. KMS-Style Grep Wiki — ✅ IMPLEMENTED

**Status:** Code complete, build passing, ready for migration.

**Files added:**

- `src/agents/tools/wiki-tool.ts` — tool definition (search/read/index)

**Files modified:**

- `src/agents/openclaw-tools.ts` — registered wiki tool
- `src/agents/tool-catalog.ts` — added wiki + scratch sections
- `src/agents/tool-display-config.ts` — added wiki + scratch display configs
- `src/agents/pi-embedded-subscribe.tools.ts` — added wiki + scratch to subscribe list

**Storage:** `~/.openclaw/wiki/` or `<workspace>/wiki/` — plain markdown files

**Features:**

- `index`: List all wiki pages with titles
- `search`: Grep across all wiki files, returns matching excerpts
- `read`: Read a specific page by relative path (with line offset/limit)
- Path traversal prevention
- Recursive directory scan up to depth 3
- Available to both main session and subagents

---

## Repository Cleanup Plan

### Phase 1: Remove unused extensions (Week 1)

```bash
cd /home/user01/clawd/openclaw-fork

# Remove unused messaging channels
rm -rf extensions/{feishu,line,mattermost,msteams,matrix,nextcloud-talk,nostr,qqbot,signal,slack,synology-chat,tlon,twitch,whatsapp,zalo,zalouser,wechat}

# Remove unused voice/video/music
rm -rf extensions/{azure-speech,deepgram,inworld,phone-control,senseaudio,talk-voice,voice-call,runway,video-generation-core,comfy,music-generation-providers*}

# Remove unused providers
rm -rf extensions/{alibaba,arcee,cerebras,chutes,deepinfra,fireworks,gradium,kilocode,lmstudio,minimax,stepfun,together,tokenjuice,vllm,voyage,qianfan,tencent,volcengine,xiaomi,zai,baidu}

# Remove enterprise/migration
rm -rf extensions/{microsoft,microsoft-foundry,google-meet,migrate-claude,migrate-hermes}

# Remove QA/testing
rm -rf extensions/{qa-*,test-support}

# Update pnpm-workspace.yaml to remove references
# Update package.json if needed
```

### Phase 2: Remove unused apps (Week 1)

```bash
# Keep only what's needed
rm -rf apps/{ios,android,macos-mlx-tts}
# Keep: apps/macos (menu bar app), apps/shared
```

### Phase 3: Document the fork (Week 2)

- Update README.md with fork goals
- Add FORK_STATUS.md tracking what's changed from upstream
- Set up CI to rebase on OpenClaw stable releases monthly

---

## Next Steps

1. **Test subagent permission fix** — spawn a subagent and have it read/write a file
2. **Remove unused extensions** — start with high-priority list
3. **Pick first feature** — recommend Session Scratch Space (highest impact)
4. **Set up fork tracking** — create branch strategy, rebase schedule

---

_Created: 2026-04-29_
_Last updated: 2026-04-29_
