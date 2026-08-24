# CRX capability-layer loader.
#
# Wired through `BASH_ENV` in .claude/settings.local.json, which bash reads for
# every NON-INTERACTIVE shell — which is exactly what the Bash tool runs. The
# settings `env` block stores literal strings and cannot expand `$PATH`, so the
# PATH edit has to happen here rather than in the JSON.
#
# Everything this file does is prepend one directory. That is the whole
# mechanism: after the shell has finished rewriting the command text — stripping
# quotes, carets, variables, redirects — it looks the program up on PATH, and
# finds ours first. Ten adversarial rounds of spellings collapse to one lookup.

CRX_SHIM_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/bin" 2>/dev/null && pwd)"

if [ -n "$CRX_SHIM_BIN" ] && [ -d "$CRX_SHIM_BIN" ]; then
  case ":$PATH:" in
    *":$CRX_SHIM_BIN:"*) : ;;                      # already first; don't stack duplicates
    *) PATH="$CRX_SHIM_BIN:$PATH"; export PATH ;;
  esac

  # `kill` is a shell BUILTIN and wins over any PATH entry, so without this the
  # kill shim is installed but never reached — an invisible failure. Disabling
  # the builtin forces the PATH lookup. Guarded because `enable` does not exist
  # in every sh that might source this.
  if [ -n "$BASH_VERSION" ]; then
    enable -n kill 2>/dev/null || true
  fi
fi
