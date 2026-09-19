#!/usr/bin/env node

import process from "node:process";

const DEFAULT_MODEL = "qwen3.8:27b-long";
const DEFAULT_ENDPOINT = "http://127.0.0.1:11434/api/chat";
const DEFAULT_CONTEXT = 131_072;
const DEFAULT_OUTPUT = 4_096;
// Large raw diffs are slower and less reliable than focused code-path packets.
// Roughly 128 KiB normally stays below 32K model tokens for source text.
const MAX_INPUT_BYTES = 128 * 1024;

function usage(message) {
  if (message) console.error(`qwen-worker: ${message}`);
  console.error(
    "Usage: node local-tools/qwen-worker.mjs --task <instructions> " +
      "[--mode <direct|deliberate>] [--model <ollama-tag>] " +
      "[--num-predict <tokens>] [--timeout-minutes <n>]\n" +
      "Optional review material is read from stdin. The result is emitted as JSON.",
  );
  process.exit(2);
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) usage(`${flag} must be a positive integer`);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    model: DEFAULT_MODEL,
    mode: "direct",
    numPredict: DEFAULT_OUTPUT,
    timeoutMinutes: 15,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--help" || flag === "-h") usage();
    if (!value) usage(`missing value for ${flag}`);
    if (flag === "--task") options.task = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--mode") {
      if (value !== "direct" && value !== "deliberate") usage("--mode must be direct or deliberate");
      options.mode = value;
    }
    else if (flag === "--num-predict") options.numPredict = parsePositiveInteger(value, flag);
    else if (flag === "--timeout-minutes") {
      options.timeoutMinutes = parsePositiveInteger(value, flag);
    } else usage(`unknown option ${flag}`);
    index += 1;
  }

  if (!options.task?.trim()) usage("--task is required");
  return options;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) {
      throw new Error(`stdin exceeds the ${MAX_INPUT_BYTES}-byte safety limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function requestModel(options, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMinutes * 60_000);
  const startedAt = Date.now();

  try {
    const response = await fetch(DEFAULT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: "<think>\n\n</think>\n\n" },
        ],
        raw: true,
        stream: true,
        think: false,
        keep_alive: "30m",
        options: {
          temperature: 0.2,
          seed: 7,
          num_ctx: DEFAULT_CONTEXT,
          num_predict: options.numPredict,
        },
      }),
    });

    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
    if (!response.body) throw new Error("Ollama returned no response stream");

    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    let finalEvent = null;

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.message?.content) answer += event.message.content;
        if (event.done) finalEvent = event;
      }
    }

    answer = answer.trim();
    if (!finalEvent) throw new Error("Ollama stream ended without a completion record");
    if (!answer) throw new Error("Qwen completed without a visible answer");
    if (finalEvent.done_reason === "length") {
      throw new Error(`Qwen exhausted the ${options.numPredict}-token output budget`);
    }
    if (answer.includes("<think>") || answer.includes("</think>")) {
      throw new Error("Qwen leaked a reasoning block into the visible answer");
    }

    return {
      answer,
      metrics: {
        wallMs: Date.now() - startedAt,
        promptTokens: finalEvent.prompt_eval_count ?? null,
        outputTokens: finalEvent.eval_count ?? null,
        promptTokensPerSecond:
          finalEvent.prompt_eval_count && finalEvent.prompt_eval_duration
            ? finalEvent.prompt_eval_count / (finalEvent.prompt_eval_duration / 1e9)
            : null,
        outputTokensPerSecond:
          finalEvent.eval_count && finalEvent.eval_duration
            ? finalEvent.eval_count / (finalEvent.eval_duration / 1e9)
            : null,
        doneReason: finalEvent.done_reason ?? null,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const material = await readStdin();
  const basePrompt = [
    options.task.trim(),
    "Return only the final deliverable. Do not expose hidden reasoning.",
    material ? `\nMATERIAL TO INSPECT:\n${material}` : "",
    "/no_think",
  ].join("\n");
  const passes = [];

  const first = await requestModel(options, basePrompt);
  passes.push(first.metrics);
  let answer = first.answer;

  if (options.mode === "deliberate") {
    const criticPrompt = [
      options.task.trim(),
      "Audit the candidate answer below against the original material.",
      "Reject unsupported claims, recover important misses, and return one corrected final deliverable.",
      "Do not mention the candidate or this audit process. Do not expose hidden reasoning.",
      "Put the entire deliverable between <final> and </final>. Write nothing outside that envelope.",
      material ? `\nORIGINAL MATERIAL:\n${material}` : "",
      `\nCANDIDATE ANSWER:\n${first.answer}`,
      "/no_think",
    ].join("\n");
    const second = await requestModel(options, criticPrompt);
    passes.push(second.metrics);
    const final = second.answer.match(/<final>\s*([\s\S]*?)\s*<\/final>/i);
    if (!final?.[1]?.trim()) throw new Error("Qwen deliberate pass omitted the required final envelope");
    answer = final[1].trim();
  }

  const sum = key => {
    const values = passes.map(pass => pass[key]);
    return values.every(value => typeof value === "number") ? values.reduce((total, value) => total + value, 0) : null;
  };

  console.log(
    JSON.stringify(
      {
        schema: "agent-control-room.qwen-worker-result/v1",
        model: options.model,
        mode: options.mode,
        answer,
        metrics: {
          wallMs: sum("wallMs"),
          promptTokens: sum("promptTokens"),
          outputTokens: sum("outputTokens"),
          passes,
        },
      },
      null,
      2,
    ),
  );
}

main().catch(error => {
  const message = error?.name === "AbortError" ? "request timed out" : error?.message ?? String(error);
  console.error(`qwen-worker: ${message}`);
  process.exitCode = 1;
});
