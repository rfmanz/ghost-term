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

You MUST rename the ghost-term tab to reflect the current topic. Call this at conversation start and whenever the topic shifts:

```bash
curl -s -X POST http://localhost:3000/api/rename-tab \
  -H "Content-Type: application/json" \
  -d '{"name":"2-4 word slug","index":0}'
```

Derive the name from the most recent user message or current activity. This is especially important in resumed conversations where prior context may be compressed.
