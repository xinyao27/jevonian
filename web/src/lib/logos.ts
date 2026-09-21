import anthropic from "@/assets/logos/anthropic.svg?raw";
import antigravity from "@/assets/logos/antigravity.png";
import claude from "@/assets/logos/claude.svg?raw";
import commandcode from "@/assets/logos/commandcode.svg?raw";
import deepseek from "@/assets/logos/deepseek.svg?raw";
import google from "@/assets/logos/google.svg?raw";
import minimax from "@/assets/logos/minimax.svg?raw";
import moonshotai from "@/assets/logos/moonshotai.svg?raw";
import openai from "@/assets/logos/openai.svg?raw";
import opencode from "@/assets/logos/opencode.svg?raw";
import openrouter from "@/assets/logos/openrouter.svg?raw";
import orcarouter from "@/assets/logos/orcarouter.png";
import qwen from "@/assets/logos/qwen.svg?raw";
import xai from "@/assets/logos/xai.svg?raw";
import zai from "@/assets/logos/zai.svg?raw";

export const PROVIDER_LOGOS: Record<string, string> = {
  anthropic,
  claude,
  "claude-subscription": claude,
  commandcode,
  deepseek,
  google,
  minimax,
  moonshotai,
  openai,
  "chatgpt-subscription": openai,
  opencode,
  "opencode-go": opencode,
  openrouter,
  qwen,
  xai,
  zai,
};

export const PROVIDER_IMAGES: Record<string, string> = {
  antigravity,
  orcarouter,
};
