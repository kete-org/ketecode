# Local models

Kete Code works with models served on your own machine or network: **Ollama**, **LM Studio**,
**vLLM**, and any OpenAI-compatible server. Nothing here needs a Kete account, the gateway or the
portal. This page covers pointing Kete at a server on another machine, seeing whether a server is
reachable, pulling Ollama models, offline mode, and models that can't call tools or have a small
context window.

## Quick start

```sh
ollama serve                        # or start LM Studio's server, or `vllm serve <model>`
ollama pull qwen2.5-coder:7b        # or: kete models pull qwen2.5-coder:7b
kete                                # the model picker lists it under "Local"
```

Kete looks for each server on its default port and lists its models a second or so after the
server answers (it checks again every 30 seconds):

| Server | Default address | Models from |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434` | `/api/tags` (+ `/api/show` for tools, vision and context size) |
| LM Studio | `http://127.0.0.1:1234` | `/api/v1/models` |
| vLLM | `http://127.0.0.1:8000` | `/v1/models` |

On first run, if you haven't picked a model yet and a local server is running with models, the
terminal UI and the web/VS Code panel offer **"Use local models (Ollama, N models)"** once.
Accepting selects one of that server's models (one that can call tools, if any can) the same way
the model picker does; it doesn't write your config.

## Servers on another machine (LAN or remote)

Point Kete at a server elsewhere with an environment variable or config. Config wins over the
environment, and the environment wins over the default:

| Server | Config (wins) | Environment |
| --- | --- | --- |
| Ollama | `providers.ollama.settings.baseURL` | `KETE_OLLAMA_HOST`, then Ollama's own `OLLAMA_HOST` |
| LM Studio | `providers.lmstudio.settings.baseURL` | `KETE_LMSTUDIO_HOST` |
| vLLM | `providers.vllm.settings.baseURL` | `KETE_VLLM_HOST` |

The host variables accept `host`, `host:port`, `[ipv6]:port` or a URL (`http://` or `https://`,
optionally with a path). Without a scheme Kete uses `http`; without a port, the server's default
port. `0.0.0.0` and `::` (a server's "listen everywhere" setting) mean this machine. An invalid
value is logged as a warning and the next source is used.

```sh
OLLAMA_HOST=192.168.1.20 kete                       # http://192.168.1.20:11434
KETE_VLLM_HOST=https://gpu.example.internal kete    # https, port 443
```

```jsonc
// ~/.config/kete/kete.jsonc or ./.kete/kete.jsonc
{
  "providers": {
    "ollama": { "settings": { "baseURL": "http://192.168.1.20:11434/v1" } }
  }
}
```

**Plain HTTP over the network.** Ollama has no TLS, so a plain `http://` address that isn't this
machine is allowed, but Kete logs a warning once: the code and prompts you send cross the network
unencrypted. Put the server behind HTTPS (a reverse proxy) if that matters on your network.
`https://` addresses are verified normally; there is no option to skip certificate checks.

## Is the server reachable?

The runtime reports each local server as **reachable** (with its model count), **unreachable**
(with the address tried and the error), **not configured** (no address set and nothing answers
on the default port, which is normal when you don't run that server) or **blocked** (offline mode
is on and the address isn't on this machine or a private network, so it isn't contacted; see
[Offline mode](#offline-mode)). Clients read this over the runtime's `kete.local-models` plugin RPC
(`POST /api/rpc/kete.local-models/status`). It never contains API keys, headers, URL credentials
or query strings: the address is shown without them, and errors are fixed texts (`can't connect:
connection refused`, `host not found`, `no answer within 2s`, `the server answered HTTP 503`), never
the underlying transport message.

- **Model picker** (terminal UI and web/VS Code): local models appear in a **Local** group with a
  **no tools** badge when the model can't call tools, and their context size (`32k ctx`). A server
  you set up that can't be reached gets one line with its address and how to start it, instead of
  silently missing models.
- **`kete models`** on a terminal shows `tools:yes|no vision:yes|no ctx:<tokens>` after each local
  model. Piped output stays one `provider/model` per line.
- Kete only probes when a client asks (opening the model picker, the first-run check); there is no
  background polling beyond the servers' own 30-second discovery.

## Pulling Ollama models: `kete models pull`

```sh
kete models pull llama3.2:3b
```

Downloads a model through the Ollama server Kete uses (the same address as above: config, then
`KETE_OLLAMA_HOST`/`OLLAMA_HOST`, then localhost), streams Ollama's progress, then has the runtime
re-read Ollama's model list so the new model is listed immediately. Ctrl-C cancels the pull.
Exit codes: `0` pulled, `1` failed (Ollama's error, an HTTP error or an unreachable server, with
the address), `2` refused (offline mode, bad input), `130` cancelled.

Kete never downloads or runs model weights itself: Ollama does the download.

**Limitation: keyed Ollama servers.** The runtime never hands API keys to clients, so
`kete models pull` sends no bearer token. Pulling into an Ollama that sits behind an
authenticating proxy fails with the proxy's HTTP error (exit `1`). Pull on that machine instead
(`ollama pull <name>`); chatting with its models through Kete works as normal, because the runtime
sends the configured `apiKey` itself.

LM Studio and vLLM have no comparable pull API; download models with their own tools.

## Offline mode

```sh
kete --offline          # or KETE_OFFLINE=1 kete
```

`--offline` reads like any boolean flag: `--offline`, `--offline=true` (or `yes`, `on`, `1`, `y`)
turn it on; `--offline=false` and `--offline false` (or `no`, `off`, `0`, `n`) leave it off. A value
the parser doesn't accept (`--offline=maybe`) is an error, and is treated as on until then.

```jsonc
{ "kete": { "offline": true } }   // in ~/.config/kete/kete.jsonc (whole process) or ./.kete/kete.jsonc
```

Offline mode uses only local models and makes no other network calls. It fails closed: an invalid
`KETE_OFFLINE` value or a non-boolean `kete.offline` counts as on.

**Which providers count as local:** any provider whose base URL host is `localhost`, a loopback
address, or a private-network IP (10/8, 172.16/12, 192.168/16, IPv6 ULA `fc00::/7`, link-local
`fe80::/10`). `ollama`, `lmstudio` and `vllm` count at their default address (this machine); with
an address set (config or `*_HOST`), the address decides like for any other provider. LAN **hostnames**
such as `gpu.lan` don't count, because deciding would need DNS: use the server's IP address in
the base URL. A request to any other provider fails with "Offline mode: `<provider>/<model>` isn't
a local model", never a silent fallback.

**Local servers at a non-local address aren't contacted at all.** An Ollama, LM Studio or vLLM
server whose address isn't local gets no request while offline mode is on: no model discovery
(`/api/tags`, `/api/show`, `/api/v1/models`, `/health`, `/v1/models`), no status probe
(`/api/ps` included), and its API key is never sent. Its status is **blocked** with "offline mode:
`<address>` isn't on this machine or a private network", and the picker shows that line.

**What offline mode turns off:**

- the models.dev catalog fetch (the bundled snapshot is used);
- the Kete gateway (models, balance, prices) and the platform: config/policy sync and runtime
  registration. `kete login` and `kete sync` are refused; `kete sync --status` and
  `kete sync --approve` still work on the local copy;
- update checks and `kete upgrade`;
- remote (URL) MCP servers and their OAuth metadata (local stdio MCP servers keep working);
- the `webfetch` and `websearch` tools (removed, and refused with an explanation if called);
- the OpenCode Console config fetch;
- `kete models pull` (Ollama would download from the internet).

LSP server auto-download doesn't exist in this runtime, so there is nothing to turn off there.
Every command uses a private server on this machine (a background service may have been started
online), and `--server` is refused, because Kete can't check that a remote server is offline too.

**Policy still applies.** Organization policy synced earlier is loaded from the cached copy and
enforced exactly as online, including its fail-closed rules. Offline mode only removes models,
servers, tools and network calls; it never widens a permission.

**Scope: which switch reaches what, and when.**

- `--offline`, `KETE_OFFLINE` and `kete.offline` in the **global** config are read once when the
  `kete` process starts (before anything else) and apply to that whole process and any server it
  starts. Only these turn off the **process-wide** parts, which are decided at startup and need a
  restart to change: the models.dev catalog fetch, update checks and `kete upgrade`, the choice of
  a private server (and refusing `--server`), and the refusals of `kete login`, `kete sync` and
  `kete models pull`.
- `kete.offline` in a **project** config (or a global config edited while Kete runs) is **live**:
  it is read from the config as currently loaded, so turning it on takes effect without a restart:
  - at once, for the next request: the model list (only local models), remote MCP servers,
    `webfetch`/`websearch`, the run check, and the local server status probe;
  - from the next tick of each background loop: Kete gateway models and prices (every 5 minutes)
    and balance (every minute), platform sync (every 5 minutes), runtime registration (daily),
    local server discovery (every 30 seconds), and the OpenCode Console config fetch (on its next
    load). A request already in flight when the setting changes finishes; nothing new is sent.
  Turning it off again resumes the same loops from their next tick.

The terminal UI's footer and the web/VS Code panel header show **Offline** while it's on.

## Models that can't call tools

Kete Code needs tools to read and edit files and run commands. Many small local models can't call
tools. When the server reports a model without tool support (`capabilities.tools: false`):

- the picker shows a **no tools** badge;
- requests to that model are sent without tools, and the agent is told it can only answer from
  the conversation;
- you see a notice once per session: this model can only answer, not edit files or run commands.

vLLM always reports `tools: false`, and some servers under-report. Override discovery in config
(`input` and `output` are required alongside `tools`):

```jsonc
{
  "providers": {
    "vllm": {
      "models": {
        "Qwen/Qwen2.5-Coder-32B-Instruct": {
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] }
        }
      }
    }
  }
}
```

## Ollama's context window

Ollama often serves a smaller context window (commonly 4096 tokens, or `OLLAMA_CONTEXT_LENGTH`)
than a model advertises, and silently drops the start of longer conversations. Kete reaches
Ollama through its OpenAI-compatible endpoint, which can't set `num_ctx` per request, so Kete
warns instead of guessing: when a model advertises more than Ollama serves (or more than 8192
tokens and the served window is unknown), the runtime logs a warning once per model and the
terminal UI shows it once when you open the model picker. To fix it on the server:

```sh
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
```

or set `PARAMETER num_ctx 32768` in a Modelfile and `ollama create` a variant. Larger windows use
more memory.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `KETE_OLLAMA_HOST` | Ollama address (wins over `OLLAMA_HOST`; config wins over both) |
| `OLLAMA_HOST` | Ollama's own variable, read when `KETE_OLLAMA_HOST` isn't set |
| `KETE_LMSTUDIO_HOST` | LM Studio address |
| `KETE_VLLM_HOST` | vLLM address |
| `KETE_OFFLINE` | `1` or `true` turns offline mode on; any other non-empty value also counts as on |

**Unattended runs (`kete job run`):** put a local server's address (and any key it needs) in your
global config, not the repository's. `kete job run` refuses a repository config that sets
`providers` unless you pass `--trust-project-config`, and the commands an unattended run executes
don't see `*_API_KEY`/`*_TOKEN` variables from your environment ([`docs/jobs.md`](jobs.md#secrets-in-an-unattended-run)).
