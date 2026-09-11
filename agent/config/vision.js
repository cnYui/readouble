// Vision relay used to read the photo (OpenAI-compatible /chat/completions).
//
// The API key is never committed. Put it in the repository-root .env as
// READOUBLE_VISION_KEY (see .env.example) and run `npm run build:agent`: that
// writes build/agent/ with the key filled in. Import that folder in Studio
// (项目「···」▸ 本地导入) and 上传云端. With an empty key the page falls back to
// the host LanguageModel.
export default {
  enabled: true,
  baseUrl: 'https://api2.ai-genesis.app/v1',
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  apiKey: '',
  // gpt-5.5 at medium effort took 21-71 s per turn here (27-96 s on the
  // previous relay) on 2026-09-11; the page's turn watchdog is this plus 10 s.
  timeoutMs: 150000
};
