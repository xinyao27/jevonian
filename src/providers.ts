import type { ProviderAuth, ProviderBilling, ProviderType } from "./config";
import type { OAuthSource } from "./oauth";

export interface ProviderPreset {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKeyEnv?: string;
  /** Short help shown next to the auth fields. */
  hint: string;
  /** Where to create or copy an API key for this provider. */
  keysUrl?: string;
  auth?: ProviderAuth;
  oauthSource?: OAuthSource;
  billing?: ProviderBilling;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    // DeepSeek speaks Chat Completions on `/v1` and Anthropic Messages on `/anthropic`.
    type: "both",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    keysUrl: "https://platform.deepseek.com/api_keys",
    hint: "Create an API key on the DeepSeek platform.",
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    keysUrl: "https://console.anthropic.com/settings/keys",
    hint: "Create an API key in the Anthropic Console.",
  },
  {
    id: "openai",
    name: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    keysUrl: "https://platform.openai.com/api-keys",
    hint: "Create an API key on the OpenAI platform.",
  },
  {
    id: "moonshotai",
    name: "Moonshot (Kimi)",
    type: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    keysUrl: "https://platform.moonshot.ai/console/api-keys",
    hint: "Create an API key in the Moonshot console.",
  },
  {
    id: "zai",
    name: "Z.ai (GLM)",
    type: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
    hint: "Create an API key in the Z.ai console.",
  },
  {
    id: "minimax",
    name: "MiniMax",
    type: "openai",
    baseUrl: "https://api.minimax.io/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
    keysUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    hint: "Create an interface key in the MiniMax user center.",
  },
  {
    id: "qwen",
    name: "Alibaba Qwen",
    type: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    keysUrl: "https://bailian.console.alibabacloud.com/#/api-key",
    hint: "Create a DashScope API key in the Alibaba Cloud Model Studio console.",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    type: "openai",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    keysUrl: "https://console.x.ai/team/default/api-keys",
    hint: "Create an API key in the xAI console.",
  },
  {
    id: "google",
    name: "Google Gemini",
    type: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    keysUrl: "https://aistudio.google.com/apikey",
    hint: "Create an API key in Google AI Studio.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    // OpenRouter speaks both Chat Completions and the Anthropic Messages API on the same key.
    type: "both",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    keysUrl: "https://openrouter.ai/settings/keys",
    hint: "Create an API key under OpenRouter → Settings → Keys.",
  },
  {
    id: "orcarouter",
    name: "OrcaRouter",
    type: "openai",
    baseUrl: "https://api.orcarouter.ai/v1",
    apiKeyEnv: "ORCAROUTER_API_KEY",
    keysUrl: "https://www.orcarouter.ai/console",
    hint: "Create an API key in the OrcaRouter console.",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    type: "both",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "OPENCODE_GO_API_KEY",
    keysUrl: "https://opencode.ai/auth",
    hint: "Sign in at opencode.ai/auth and copy a Go / Zen API key.",
    billing: "subscription",
  },
  {
    id: "commandcode",
    name: "Command Code",
    type: "both",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    apiKeyEnv: "COMMAND_CODE_API_KEY",
    keysUrl: "https://commandcode.ai",
    hint: "Sign in on Command Code and create a provider API key.",
    billing: "subscription",
  },
  {
    id: "claude-subscription",
    name: "Claude (Pro/Max)",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    auth: "oauth",
    oauthSource: "claude-code",
    keysUrl: "https://code.claude.com/docs/en/oauth",
    hint: "Sign in with `claude`; Jevonian reads ~/.claude/.credentials.json.",
    billing: "subscription",
  },
  {
    id: "chatgpt-subscription",
    name: "ChatGPT (Codex)",
    type: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    auth: "oauth",
    oauthSource: "codex",
    keysUrl: "https://github.com/openai/codex#authentication",
    hint: "Sign in with `codex`; Jevonian reads ~/.codex/auth.json.",
    billing: "subscription",
  },
  {
    id: "antigravity",
    name: "Antigravity (Google)",
    type: "gemini",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    auth: "oauth",
    oauthSource: "antigravity",
    keysUrl: "https://antigravity.google",
    hint: "Sign in with the Antigravity IDE or `agy`; reads the local token and project id.",
    billing: "subscription",
  },
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

export function typeFromNpm(npm: string | undefined): ProviderType {
  if (npm && npm.toLowerCase().includes("anthropic")) return "anthropic";
  return "openai";
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
