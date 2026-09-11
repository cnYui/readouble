// Vision relay used to read the photo (OpenAI-compatible /chat/completions).
//
// The API key is intentionally empty in Git: this repository is public, and a
// committed key is scraped within minutes. To use the relay, paste the key into
// `apiKey` in AIUI Studio's 代码 editor (this file), then 上传云端. Re-importing
// from GitHub overwrites the Studio copy, so paste it again after each import.
//
// With an empty key the page falls back to the host LanguageModel.
export default {
  enabled: true,
  baseUrl: 'https://api.aaccx.pw/v1',
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  apiKey: '',
  timeoutMs: 60000
};
