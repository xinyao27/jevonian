import { createInterface } from "node:readline";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function ask(question: string, fallback = ""): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = await readLine(`${question}${suffix}: `);
  return answer.trim() || fallback;
}

export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const answer = await readLine(`${question}: `);
    return answer.trim();
  }
  process.stdout.write(`${question}: `);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let buffer = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    const finish = (value: string | null, error?: Error) => {
      cleanup();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          finish(null, new Error("cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(buffer);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += char;
      }
    };
    stdin.on("data", onData);
  });
}

export async function askChoice<T>(
  question: string,
  choices: T[],
  label: (choice: T) => string,
  defaultIndex = 0,
): Promise<T> {
  for (const [index, choice] of choices.entries()) {
    process.stdout.write(`  ${index + 1}) ${label(choice)}\n`);
  }
  const answer = await ask(question, String(defaultIndex + 1));
  const selected = Number.parseInt(answer, 10);
  const choice = choices[selected - 1] ?? choices[defaultIndex];
  if (choice === undefined) throw new Error("no choice available");
  return choice;
}

export async function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const answer = (await ask(`${question} (y/n)`, defaultYes ? "y" : "n")).toLowerCase();
  return answer.startsWith("y");
}
