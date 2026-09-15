# pi-web-search

Provider-native web search for [pi](https://pi.dev) with Gemini + URL Context, xAI Grok, OpenAI Responses variants, and Anthropic.

## Tools

### `web_search`

Search the web using your currently selected model. Automatically picks the right provider API:

| Provider | API |
|---|---|
| Google Gemini | Grounding with Google Search |
| xAI Grok | Responses API `web_search` |
| OpenAI | Responses API web search |
| Azure OpenAI | Responses API web search (`azure-openai-responses`) |
| OpenAI Codex | Codex Responses API web search (`openai-codex-responses`) |
| GitHub Copilot | OpenAI Responses API web search via Copilot credentials |
| Anthropic | Messages API web search |

GitHub Copilot OpenAI Responses models are supported, including Business and Enterprise seats whose API endpoint is resolved from their authenticated Copilot credentials. This includes models such as `gpt-5.6-sol`.

Supports passing up to 20 additional URLs to analyze alongside the query. Successful `web_search` results are collapsed by default in pi; expand the tool call to inspect the full answer and source details.

### `url_context`

Gemini-only. Analyze up to 20 public URLs — web pages, documents, images, and YouTube videos. Uses Gemini's native URL Context retrieval with verified metadata.

When using `google-generative-ai`, YouTube URLs are passed as `file_data` for native video understanding.

## Install

```bash
pi install npm:pi-web-search
```

## Usage

No extra config needed. Select a supported current model in pi and the tools auto-detect the matching provider API.

`web_search` will not scan configured models and pick one automatically when the current model does not support native search. To use a dedicated search model, opt in explicitly with `web-search.json` in pi's agent directory (by default `~/.pi/agent/`; respects `PI_CODING_AGENT_DIR`):

```json
{
  "provider": "openai",
  "model": "gpt-5.1"
}
```

When this file exists, `web_search` uses the configured provider/model first. If it is missing, `web_search` uses the current conversation model. If the selected model does not support native search, the tool returns an error instead of falling back.

### Fallback Search Model

To protect against transient upstream capacity outages (such as `server_is_overloaded`, HTTP 503 Service Unavailable, 504 Gateway Timeout, or rate limits), you can explicitly declare a fallback search model (or array of models):

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.6-luna",
  "fallback": {
    "provider": "google-generative-ai",
    "model": "gemini-2.5-flash"
  }
}
```

Or a multi-tier fallback chain:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.6-luna",
  "fallback": [
    { "provider": "google-generative-ai", "model": "gemini-2.5-flash" },
    { "provider": "anthropic", "model": "claude-3-7-sonnet-20250219" }
  ]
}
```

- **Strictly Opt-In**: Fallback only activates when explicitly configured in `web-search.json`. Unconfigured setups retain the default fail-fast behavior without unexpected model switching or surprise billing.
- **Transient Gating**: Fallback only triggers on recoverable provider failures (overloaded, rate limits, 5xx server errors, network drops). Terminal client-side errors fail fast immediately.
- **Auditable**: When failover occurs, the tool streams an informational status update and records `fallbackUsed: true` with the executed model in the returned tool details.

For OpenAI Responses models (including Azure, Codex, and Copilot), `web_search` inherits the agent's current thinking level on each call. Enabled levels are clamped to the selected search model's supported levels and translated through its `thinkingLevelMap` using pi's model metadata. This also applies when `web-search.json` selects a dedicated search model. Higher effort can increase latency and cost.

When thinking is off or unavailable, or the search model is non-reasoning, the request omits `reasoning` and leaves the choice to the provider. Off does not force reasoning off: some models reject `reasoning.effort: "none"`. Google, Anthropic, and xAI behavior is unchanged.

`url_context` is automatically removed from active tools when using a non-Gemini model.

## Test

```bash
cp .env.example .env   # edit with your models
npm test               # unit tests
npm run test:real:web-search
npm run test:real:url-context
```

## License

MIT
