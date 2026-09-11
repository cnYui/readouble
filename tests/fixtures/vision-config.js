// Test-only relay config: a fake key and a fake host, used by page tests
// through loadPageDefinition(..., { importOverrides }).
export default {
  enabled: true,
  baseUrl: 'https://relay.example/v1',
  model: 'vision-model',
  reasoningEffort: 'medium',
  apiKey: 'fixture-key',
  timeoutMs: 150000
};
