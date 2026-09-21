const NAME_OVERRIDES: Record<string, string> = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  moonshotai: "Moonshot",
  moonshot: "Moonshot",
  zai: "Z.ai",
  minimax: "MiniMax",
  qwen: "Alibaba Qwen",
  xai: "xAI",
  google: "Google Gemini",
  orcarouter: "OrcaRouter",
  "opencode-go": "OpenCode Go",
  commandcode: "Command Code",
  antigravity: "Antigravity",
  "claude-subscription": "Claude",
  "chatgpt-subscription": "ChatGPT",
  chatgpt: "ChatGPT",
  codex: "ChatGPT",
};

export function providerDisplayName(name: string): string {
  const override = NAME_OVERRIDES[name];
  if (override) return override;
  const base = name.endsWith("-subscription") ? name.slice(0, -"-subscription".length) : name;
  return base
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
