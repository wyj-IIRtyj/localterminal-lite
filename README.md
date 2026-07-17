# LocalTerminal Lite

LocalTerminal Lite is a single-workspace local WebDev server with:

- persistent multi-session registration and messaging;
- ChatGPT Apps access over MCP Streamable HTTP;
- ChatGPT Actions access through a generated OpenAPI 3.1 document;
- exactly three model-visible facade tools;
- a declarative extension registry;
- an interactive full-screen terminal UI.

It intentionally does not include the Full edition's browser automation, desktop control, multimodal observation, React Dashboard, GitHub control plane, Harness/Episode framework, or Actions parity program.

## Install and run

```bash
cd lite
npm install
npm run dev
```

首次启动会打开全屏配置向导。工作区、监听地址、公网 URL、运行限制和接入凭据都由 TUI 管理并持久化；不需要创建或编辑 `.env`。高级无界面部署可以通过进程环境变量临时覆盖设置。

The TUI is the primary interface. It displays server endpoints and runtime state and supports:

- `1`-`6` or Tab: switch views;
- `n`: register a session;
- `u`: update session status;
- `m`: send a message between sessions;
- `e`: register a custom builtin alias;
- `x`: remove a custom extension;
- `c`: configure workspace, network, and runtime limits, then restart safely;
- `v`: reveal or mask Apps and Actions credentials;
- `k`: rotate both connection credentials;
- `q`: stop the server.

For a service process without terminal controls:

```bash
npm run build
npm run start -- --headless
```

## Connect ChatGPT Apps

The TUI prints the exact MCP URL:

```text
https://your-public-domain.example/mcp/<generated-connector-key>
```

Expose the local server through an HTTPS tunnel, then create a developer-mode app in ChatGPT and paste that URL. The server advertises exactly:

- `extension_discover`
- `extension_register`
- `extension_call`

## Connect ChatGPT Actions

Import the OpenAPI URL printed by the TUI:

```text
https://your-public-domain.example/openapi.json
```

Configure Bearer authentication with the Actions token shown in the TUI's Settings view (`v` toggles visibility).

The default document is OpenAPI 3.1.0, as required by the current ChatGPT Actions importer, and exposes exactly three operations: `extensionDiscover`, `extensionRegister`, and `extensionCall`. Its `components.schemas` section is always a concrete object containing the request and response schemas. `/openapi-3.1.json` remains as an equivalent compatibility alias.

## Extension workflow

1. Call `extension_discover` to inspect available builtins, schemas, and registration instructions.
2. Call `extension_register` with `action=validate` and a declarative spec.
3. Call it again with `action=upsert` after validation.
4. Invoke the custom tool through `extension_call`.

Custom extensions support:

- a builtin alias with optional default arguments;
- an executable with a list of argument templates such as `{{input.path}}`.

Commands use direct process spawning rather than implicit shell interpolation. A custom extension can explicitly select a shell executable, but it is then correctly marked as consequential.

## Multi-session collaboration

Concrete collaboration tools behind `extension_call` include:

- `session_register`, `session_list`, `session_update`, `session_unregister`;
- `message_send`, `message_inbox`, `message_list`.

Apps calls use ChatGPT's anonymized conversation-session hint for correlation when present. Actions callers can pass `sessionId` explicitly. Authorization never relies on a session hint.

## Security boundary

- Only one configured workspace is authorized.
- Real paths and symlinks are checked before access.
- `.localterminal-lite` cannot be read or edited through extension file tools.
- command output, file reads, traversal, and execution time are bounded.
- Actions require a Bearer token; Apps use an unguessable connector URL.
- This is a single-user local development tool, not a multi-tenant hosted execution service.
