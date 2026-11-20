# shellcheck shell=sh
# Defaults for every login shell inside the per-user container.
case ":$PATH:" in *:/opt/ai/bin:*) ;; *) export PATH=/opt/ai/bin:/usr/local/cuda/bin:/opt/rust/bin:$PATH:/opt/sec/bin ;; esac
export RUSTUP_HOME=/opt/rust CARGO_HOME=/opt/rust

# Your personal key for the lab LLM (OpenAI- and Anthropic-compatible), managed in the admin panel.
if [ -r /etc/lab/user/llm.env ]; then
    set -a; . /etc/lab/user/llm.env; set +a
fi

if [ -n "${PS1:-}" ] && [ -z "${LAB_MOTD_SHOWN:-}" ]; then
    export LAB_MOTD_SHOWN=1
    if [ "${LAB_SUDO:-1}" = 1 ]; then _r=", with sudo"; else _r=""; fi
    echo "Your own container lab-${USER}${_r}. Run 'lab-help' for tools, storage and the language model."; unset _r
fi
