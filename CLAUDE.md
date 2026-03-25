# ghost-term

## Python tools

When installing Python packages (e.g. yt-dlp), use `uv` with a local `.venv` in this project folder instead of installing globally. This keeps the global Python environment clean.

```bash
# Create venv (if not already present)
uv venv .venv

# Install packages
uv pip install <package>

# Run tools
.venv/Scripts/<tool>.exe   # Windows
.venv/bin/<tool>            # WSL/Linux
```

## Large files (Git LFS)

Video clips in `clips/` are tracked by Git LFS (see `.gitattributes`). No special steps needed — just use normal git commands and LFS handles it.

To add a new tracked pattern: `git lfs track "pattern"`

## Tab naming

You MUST keep the ghost-term tab name aligned with the active conversation topic. Rename it at conversation start, after a clear topic shift, and when a resumed/compressed session needs to be re-grounded.

Name selection rules:

- Base it on a short summary of the current active conversation, not just the last message in isolation.
- Weight recent user turns and the current work item most heavily.
- Use 2-4 words, prefer spaces over hyphens, and keep it readable in the tab bar.
- Prefer stable noun-phrase style labels over imperative prompts.
- Ignore generic follow-ups like `implement the plan`, `continue`, `do it`, and similar low-context turns.
- If the topic has not materially changed, keep the current name instead of churning it.

Call the existing rename API:

```bash
curl -s -X POST http://localhost:3000/api/rename-tab \
  -H "Content-Type: application/json" \
  -d '{"name":"2-4 word slug","index":0}'
```

The project Stop hook in `hooks/auto-rename.js` is a fallback that derives the same kind of label from the Claude transcript when available.
