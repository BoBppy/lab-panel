# Per-person dev container: CUDA, compilers, AI and security tooling, shared Python environments.
# Build:  sudo lab-ctl build    (reads optional --build-arg lines from /etc/lab/devbox.args)
# Every package source defaults to upstream. Where upstream is slow, set mirrors as build args;
# mirrors-cn.args is a ready-made set for mainland China.
ARG CUDA_IMAGE=docker.io/nvidia/cuda:13.4.3-cudnn-devel-ubuntu24.04
FROM ${CUDA_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=Etc/UTC

ARG APT_MIRROR=
ARG PIP_INDEX=https://pypi.org/simple
ARG GEM_SOURCE=https://rubygems.org/
ARG NODE_DIST=https://nodejs.org/dist
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG RUSTUP_DIST_SERVER=https://static.rust-lang.org
ARG RUSTUP_UPDATE_ROOT=https://static.rust-lang.org/rustup
ARG CRATES_INDEX=

# filter: install only names this Ubuntu release has, so one renamed package can't break the build
COPY apt-install /usr/local/sbin/apt-install
RUN chmod 755 /usr/local/sbin/apt-install \
 && if [ -n "$APT_MIRROR" ]; then sed -i -e "s#http://archive.ubuntu.com#${APT_MIRROR}#g" \
        -e "s#http://security.ubuntu.com#${APT_MIRROR}#g" /etc/apt/sources.list.d/ubuntu.sources; fi \
 && printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries \
 && userdel -r ubuntu 2>/dev/null || true

# --- base + computer science toolchain
RUN apt-install \
      openssh-sftp-server openssh-client sudo bash-completion ca-certificates tzdata locales man-db manpages-dev \
      curl wget aria2 git git-lfs vim neovim nano tmux screen htop btop nvtop iotop ncdu less rsync zip unzip p7zip-full \
      zstd pigz pv file tree jq parallel entr direnv fzf ripgrep fd-find bat hyperfine shellcheck \
      build-essential gcc-multilib g++-multilib clang lld lldb llvm clang-format clang-tidy cmake ninja-build meson \
      pkg-config autoconf automake libtool bison flex ccache gdb gdb-multiarch valgrind strace ltrace patchelf \
      python3 python3-pip python3-venv python3-dev \
      openjdk-21-jdk-headless maven golang-go \
      sqlite3 postgresql-client mariadb-client redis-tools protobuf-compiler graphviz doxygen pandoc gnuplot-nox \
      iproute2 iputils-ping net-tools dnsutils procps psmisc lsof sysstat zsh fish \
      libssl-dev libffi-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev liblzma-dev libgl1 libglib2.0-0 \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd && ln -sf /usr/bin/batcat /usr/local/bin/bat \
 && rm -rf /var/lib/apt/lists/*

# --- security / CTF (no raw sockets: containers run without NET_RAW, so use connect scans, e.g. nmap -sT)
RUN apt-install \
      nmap ncat netcat-openbsd socat tcpdump tshark whois traceroute mtr-tiny iperf3 telnet proxychains4 \
      wireguard-tools openvpn smbclient ldap-utils \
      hydra medusa john hashcat sqlmap nikto gobuster ffuf dirb wfuzz \
      binwalk radare2 nasm yara foremost sleuthkit testdisk libimage-exiftool-perl steghide hexedit xxd \
      qemu-user qemu-user-static upx-ucl checksec fcrackzip pdfcrack crunch ruby-full \
 && gem install --no-document --clear-sources --source "$GEM_SOURCE" one_gadget zsteg seccomp-tools \
 ; rm -rf /var/lib/apt/lists/*

# --- Node.js (current LTS) + coding agents that can talk to the local LLM
RUN set -e; v=$(curl -fsSL --retry 5 "$NODE_DIST/index.json" \
        | python3 -c 'import sys,json; print(next(x["version"] for x in json.load(sys.stdin) if x["lts"]))'); \
    curl -fsSL --retry 5 "$NODE_DIST/$v/node-$v-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1; \
    npm config -g set registry "$NPM_REGISTRY"; \
    npm install -g @anthropic-ai/claude-code @openai/codex; npm cache clean --force

# --- Rust
ENV RUSTUP_HOME=/opt/rust CARGO_HOME=/opt/rust RUSTUP_DIST_SERVER=${RUSTUP_DIST_SERVER} RUSTUP_UPDATE_ROOT=${RUSTUP_UPDATE_ROOT}
RUN curl -fsSL --retry 5 "$RUSTUP_UPDATE_ROOT/dist/x86_64-unknown-linux-gnu/rustup-init" -o /tmp/rustup-init \
 && chmod +x /tmp/rustup-init && /tmp/rustup-init -y --no-modify-path --profile default && rm /tmp/rustup-init \
 && if [ -n "$CRATES_INDEX" ]; then printf '[source.crates-io]\nreplace-with = "mirror"\n[source.mirror]\nregistry = "%s"\n' "$CRATES_INDEX" > /opt/rust/config.toml; fi \
 && chgrp -R sudo /opt/rust && chmod -R g+w /opt/rust

# --- Python: uv, plus two shared environments (group-writable so users can add packages without sudo)
#   /opt/ai   PyTorch (CUDA wheels from the package index), HF stack, data science, Jupyter
#   /opt/sec  CTF / security Python tools whose pins conflict with the AI stack (angr)
RUN printf '[global]\nindex-url = %s\n' "$PIP_INDEX" > /etc/pip.conf \
 && pip3 install --no-cache-dir --break-system-packages uv nvitop
ENV UV_DEFAULT_INDEX=${PIP_INDEX} UV_LINK_MODE=copy UV_NO_CACHE=1
RUN uv venv --python /usr/bin/python3 /opt/ai \
 && uv pip install --python /opt/ai/bin/python \
      torch torchvision torchaudio \
      transformers accelerate datasets peft trl bitsandbytes sentencepiece tokenizers safetensors \
      "huggingface_hub[cli,hf_xet]" evaluate einops timm deepspeed tensorboard wandb \
      numpy pandas polars pyarrow scipy statsmodels sympy networkx scikit-learn xgboost lightgbm \
      matplotlib seaborn plotly opencv-python-headless pillow \
      jupyterlab ipywidgets ipython rich tqdm gradio fastapi uvicorn \
      openai anthropic tiktoken \
      pwntools pycryptodome requests beautifulsoup4 lxml paramiko \
 && /opt/ai/bin/python -c "import torch; print('torch', torch.__version__, 'cuda', torch.version.cuda)" \
 && chgrp -R sudo /opt/ai && chmod -R g+w /opt/ai
RUN uv venv --python /usr/bin/python3 /opt/sec \
 && uv pip install --python /opt/sec/bin/python \
      pwntools ROPgadget ropper angr z3-solver capstone unicorn pycryptodome gmpy2 scapy impacket volatility3 \
      requests beautifulsoup4 ipython \
 && chgrp -R sudo /opt/sec && chmod -R g+w /opt/sec \
 && for t in ROPgadget ropper vol volshell; do [ -e /opt/sec/bin/$t ] && ln -sf /opt/sec/bin/$t /usr/local/bin/$t; done; true

# pip inside both environments (uv venv creates none), group-writable like the rest
RUN for v in /opt/ai /opt/sec; do uv pip install --python $v/bin/python pip \
      && chgrp -R sudo $v/lib/python3*/site-packages/pip* $v/bin/pip* && chmod -R g+w $v/lib/python3*/site-packages/pip* $v/bin/pip*; done

COPY lab-init.sh /usr/local/sbin/lab-init
COPY profile.sh  /etc/profile.d/lab.sh
COPY lab-help    /usr/local/bin/lab-help
RUN chmod 755 /usr/local/sbin/lab-init /etc/profile.d/lab.sh /usr/local/bin/lab-help \
 && echo 'source /etc/profile.d/lab.sh' >> /etc/zsh/zprofile

ENTRYPOINT ["/usr/local/sbin/lab-init"]
