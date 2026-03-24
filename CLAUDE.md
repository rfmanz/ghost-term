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
