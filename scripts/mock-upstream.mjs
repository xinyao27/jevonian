import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 9999);

const usage = {
  prompt_tokens: 1200,
  completion_tokens: 45,
  prompt_tokens_details: { cached_tokens: 800 },
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    json(res, 200, {
      object: "list",
      data: [{ id: "mock-model", object: "model", owned_by: "mock" }],
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const body = await readBody(req);
    if (String(body.model ?? "").startsWith("claude-mock-")) {
      json(res, 400, {
        error: {
          message: `Model "${body.model}" must be called via /provider/v1/messages (Anthropic Messages shape).`,
          type: "invalid_request_error",
          code: "unsupported_model",
        },
      });
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(
        `data: ${JSON.stringify({ id: "mock", choices: [{ delta: { content: "hello" } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: "mock", choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    json(res, 200, {
      id: "mock",
      object: "chat.completion",
      model: body.model,
      choices: [
        { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
      ],
      usage,
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/responses") {
    const body = await readBody(req);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write(
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_mock", model: body.model } })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: "hello from responses" })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_mock",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "hello from responses" }],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: 40 },
          },
        },
      })}\n\n`,
    );
    res.end();
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/v1internal:generateContent")) {
    await readBody(req);
    json(res, 200, {
      response: {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "hello from gemini" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        modelVersion: "gemini-3-flash",
        responseId: "resp_mock",
      },
      traceId: "trace_mock",
    });
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/v1internal:streamGenerateContent")) {
    await readBody(req);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write(
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "hello " }] } }] } })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "from gemini" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
        },
      })}\n\n`,
    );
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/v1/systemone") {
    const body = await readBody(req);
    const state = body.state ?? {};
    const failures =
      typeof state.consecutive_failures === "number" ? state.consecutive_failures : 0;
    // A brain answers with a routing id, not a model id: the router resolves the id against the
    // offers it sent and takes the first healthy model in that pool. Answering a model name
    // would be unrecognised and silently fall back to the first offer.
    const routings = Array.isArray(state.routings) ? state.routings.map((entry) => entry.id) : [];
    // Mirror the routing rule the smoke test asserts: plan until tool results arrive, execute
    // while progress holds, plan again once failures pile up.
    const wantCheap = state.has_tool_results === true && failures < 2;
    const preferred = wantCheap ? "execute" : "plan";
    const choice = routings.includes(preferred) ? preferred : (routings[0] ?? "none_of_the_above");
    // Answer the effort question when it is asked, and stay silent when it is not: a mock that
    // always answered would hide a router that ignored `brainPicksEffort`.
    const askedEffort = Object.hasOwn(body.questions ?? {}, "effort");
    json(res, 200, {
      model: "jev-1.13.0",
      answers: {
        model: {
          choice,
          confidence: 0.93,
        },
        ...(askedEffort
          ? { effort: { choice: wantCheap ? "low" : "high", confidence: 0.93 } }
          : {}),
      },
      usage: { input_tokens: 120, output_tokens: 8 },
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/messages") {
    const body = await readBody(req);
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 900, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 } } })}\n\n`,
      );
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 30 } })}\n\n`,
      );
      res.end();
      return;
    }
    json(res, 200, {
      id: "mock",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      usage: {
        input_tokens: 900,
        output_tokens: 30,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 100,
      },
    });
    return;
  }

  json(res, 404, { error: { message: "not found", type: "not_found" } });
}).listen(port, "127.0.0.1", () => {
  console.log(`mock upstream on http://127.0.0.1:${port}`);
});
