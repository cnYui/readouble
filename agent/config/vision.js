// Vision relay used to read the photo (OpenAI-compatible /chat/completions).
//
// The API key is never committed. Put it in the repository-root .env as
// READOUBLE_VISION_KEY (see .env.example) and run `npm run build:agent`: that
// writes build/agent/ with the key filled in. Import that folder in Studio
// (项目「···」▸ 本地导入) and 上传云端. With an empty key the page falls back to
// the host LanguageModel.
export default {
  enabled: true,
  baseUrl: 'https://api.aaccx.pw/v1',
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  apiKey: '',
  timeoutMs: 60000
};
