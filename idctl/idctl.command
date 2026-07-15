#!/bin/sh
# Double-clickable macOS launcher. Finder opens this in Terminal.app, giving a
# real TTY so the idctl TUI mounts (raw-mode keyboard input needs a real PTY).
# Do not pipe/redirect stdin here — idctl falls back to a snapshot without a TTY.
if command -v idctl >/dev/null 2>&1; then
  exec idctl
elif [ -x "$HOME/.local/bin/idctl" ]; then
  exec "$HOME/.local/bin/idctl"
else
  echo "idctl is not installed yet. Install it with:"
  echo "  curl -fsSL https://github.com/bobofbuilding/idacc/releases/latest/download/install.sh | sh"
  echo
  printf "Press Return to close… "; read _
fi
