 I looked through packages/rpiv-btw (README.md, btw.ts, btw-ui.ts, tests, prompt).

 Notable features in the JuiceSharp /btw that we have not ported as-is:

 1. Tool-less side answer
     - Calls the model with tools: [].
     - Safer: /btw can’t run commands or edit files.
     - Our current /btw uses a full ghost AgentSession, so tools are available.
 2. Dedicated one-shot “answer panel” UX
     - /btw <question> opens a bottom panel with:
         - banner showing the question
         - pending …
         - answer/error body
         - footer hints
     - Not an interactive mini chat box like our ghost overlay.
 3. Custom /btw system prompt
     - Tells the model:
         - treat main conversation as background
         - don’t continue prior assistant work/tool calls
         - answer directly/concisely
         - cite files/functions/line numbers when grounded
         - no tools/plain text only
 4. Per-session /btw Q&A history
     - Prior /btw questions/answers are included in future /btw calls.
     - History is separate from the main session and not persisted to disk.
 5. Process-wide in-memory state
     - Uses globalThis[Symbol.for("rpiv-btw")].
     - Survives extension reload/import churn within the same Pi process.
     - Lost when Pi exits.
 6. Cross-session hint
     - Appends the last 10 /btw question strings across all sessions to the system prompt as a “recent
       topics” hint.
     - The prompt says to treat this only as a high-level pattern hint.
 7. Clear /btw history key
     - Press x in the panel to clear this session’s /btw history.
 8. Snapshot caching
     - On message_end, it snapshots the main branch’s converted LLM messages.
     - Skips snapshotting assistant messages with stopReason === "toolUse".
     - Invalidates snapshot on session_compact and session_tree.
 9. Abort behavior
     - Uses its own AbortController.
     - Esc cancels the in-flight side model request and dismisses the panel.
 10. More explicit error surfacing
 - Handles no model, no API key, model misconfiguration, provider error stop reason, empty text
   response, thrown errors, and abort separately.

 My take: the only high-value candidates to port are probably custom system prompt, tool-less mode
 option, clear side history, and maybe Esc abort semantics if our full ghost session doesn’t already
 behave how you want. The snapshot cache/cross-session hint feels more like the bloat you wanted to
 avoid.
