#!/usr/bin/env node
// B3 inference sidecar.
//
// Reads one JSON request from stdin, calls the EigenCloud AI Gateway through
// the official `@layr-labs/ai-gateway-provider` (which auto-handles the
// TEE-attested JWT flow when KMS_SERVER_URL + KMS_PUBLIC_KEY are set, and
// falls back to KMS_AUTH_JWT for local dev), then writes the full result —
// including the raw gateway response body AND response headers — to stdout.
//
// We hand the Python layer everything the gateway emits so it can extract
// any receipt / signature the gateway publishes today (the exact field
// names are not yet stable) without us guessing.
//
// Stdin shape:
//   {
//     "model":       "anthropic/claude-sonnet-4.6" | "gpt-oss-120b-f16" | ...
//     "messages":    [{ "role": "system|user|assistant", "content": "..." }, ...],
//     "seed":        42,             // optional, for determinism
//     "temperature": 0.0,            // optional
//     "max_tokens":  600             // optional
//   }
//
// Stdout shape (success):
//   {
//     "ok":              true,
//     "text":            "<assistant text>",
//     "model":           "<actual model id reported by the gateway>",
//     "usage":           { "promptTokens":…, "completionTokens":…, "totalTokens":… },
//     "request_body":    { …exact OpenAI-shape body the provider posted… },
//     "response_body":   { …full gateway JSON; contains the receipt/signature if any… },
//     "response_headers":{ …all response headers… }
//   }
//
// Stdout shape (failure):
//   { "ok": false, "error": "<message>" }
//
// Env:
//   EIGEN_GATEWAY_URL    default https://ai-gateway-dev.eigencloud.xyz
//   KMS_AUTH_JWT         bearer JWT (local-dev override; bypasses attestation)
//   KMS_SERVER_URL       set automatically inside EigenCompute TEE
//   KMS_PUBLIC_KEY       set automatically inside EigenCompute TEE

import { createEigenGateway } from "@layr-labs/ai-gateway-provider";
import { generateText } from "ai";

// OpenAI fallback (used when USE_OPENAI_FALLBACK=true). Bypasses the EigenAI
// gateway entirely — keeps the same TEE attestation envelope, but the AI
// inference itself comes from OpenAI's API. We re-enable the EigenAI path
// (and lose this fallback) as soon as Eigen Labs fixes the gateway-KMS
// keypair mismatch documented in Documents/eigencloud-ai-gateway-401-fix.md.
async function callOpenAIDirect(req) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "USE_OPENAI_FALLBACK is set but OPENAI_API_KEY is missing" };
  }
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const body = {
    model,
    messages: req.messages,
    ...(req.seed != null ? { seed: req.seed } : {}),
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.max_tokens != null ? { max_tokens: req.max_tokens } : {}),
  };
  let resp;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `openai network error: ${e?.message || String(e)}` };
  }
  const raw = await resp.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: `openai non-JSON response (${resp.status}): ${raw.slice(0, 500)}` };
  }
  if (!resp.ok) {
    return {
      ok: false,
      error: `openai error ${resp.status}: ${json?.error?.message || raw.slice(0, 500)}`,
    };
  }
  const choice = json?.choices?.[0];
  const text =
    typeof choice?.message?.content === "string"
      ? choice.message.content
      : Array.isArray(choice?.message?.content)
        ? choice.message.content.filter((p) => p?.type === "text").map((p) => p.text).join("")
        : "";
  return {
    ok: true,
    text,
    model: json.model || model,
    usage: json.usage || null,
    request_body: body,
    response_body: json,
    response_headers: Object.fromEntries(resp.headers.entries()),
  };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function buildProviderConfig() {
  // As of 2026-05-12 the gateway only validates JWTs from the sepolia-dev
  // KMS — both ai-gateway.eigencloud.xyz and ai-gateway-dev.eigencloud.xyz
  // reject sepolia-prod/mainnet-alpha JWTs with `crypto/rsa: verification
  // error`. We default to the dev gateway and deploy via the dev-tagged
  // ecloud-cli so the pair lines up.
  const baseURL = process.env.EIGEN_GATEWAY_URL || "https://ai-gateway-dev.eigencloud.xyz";
  const jwt = process.env.KMS_AUTH_JWT || undefined;
  const kmsServerURL = process.env.KMS_SERVER_URL;
  const kmsPublicKey = process.env.KMS_PUBLIC_KEY;
  const attestConfig =
    kmsServerURL && kmsPublicKey
      ? { kmsServerURL, kmsPublicKey, audience: "llm-proxy" }
      : undefined;
  return { baseURL, jwt, attestConfig, debug: process.env.DEBUG === "true" };
}

async function main() {
  let req;
  try {
    req = JSON.parse(await readStdin());
  } catch (e) {
    emit({ ok: false, error: `bad stdin json: ${e.message}` });
    process.exit(2);
  }

  // Short-circuit to the OpenAI fallback when explicitly enabled. Keeps the
  // exact same stdout JSON contract so severity_assessor.py doesn't care
  // which provider answered.
  if (process.env.USE_OPENAI_FALLBACK === "true" || process.env.USE_OPENAI_FALLBACK === "1") {
    process.stderr.write("[b3-inference] USE_OPENAI_FALLBACK=true — routing to OpenAI\n");
    const out = await callOpenAIDirect(req);
    emit(out);
    if (!out.ok) process.exit(7);
    return;
  }

  const cfg = buildProviderConfig();
  if (!cfg.jwt && !cfg.attestConfig) {
    emit({
      ok: false,
      error:
        "no auth — inside EigenCompute KMS_SERVER_URL+KMS_PUBLIC_KEY are auto-injected; for local dev set KMS_AUTH_JWT",
    });
    process.exit(3);
  }

  // Diagnostic — log effective config to stderr so it lands in app logs.
  process.stderr.write(
    `[b3-inference] baseURL=${cfg.baseURL} attest=${!!cfg.attestConfig} jwt=${!!cfg.jwt} ` +
    `KMS_SERVER_URL=${process.env.KMS_SERVER_URL || "(unset)"} ` +
    `KMS_PUBLIC_KEY_set=${!!process.env.KMS_PUBLIC_KEY}\n`,
  );

  // The provider's `debug: true` mode writes to stdout, which collides with
  // our JSON-on-stdout protocol. Force debug off here; users wanting verbose
  // output should run the sidecar with DEBUG_PROVIDER_STDERR=1 instead.
  cfg.debug = false;

  const gateway = createEigenGateway(cfg);
  const model = gateway(req.model);

  // generateText accepts either `prompt` or `messages`. We always have
  // messages from the Python layer.
  const opts = {
    model,
    messages: req.messages,
  };
  if (req.seed != null) opts.seed = req.seed;
  if (req.temperature != null) opts.temperature = req.temperature;
  if (req.max_tokens != null) opts.maxOutputTokens = req.max_tokens;

  let result;
  try {
    result = await generateText(opts);
  } catch (e) {
    emit({ ok: false, error: `gateway call failed: ${e?.message || String(e)}` });
    process.exit(4);
  }

  // Extract structured fields. ai SDK exposes response.body (raw JSON from
  // the gateway) and response.headers — these are where any receipt /
  // signature material lives.
  const respBody = result.response?.body ?? null;
  const respHeaders = result.response?.headers ?? {};
  const reqBody = result.request?.body ?? null;

  emit({
    ok: true,
    text: result.text || "",
    model: result.response?.modelId || req.model,
    usage: result.usage || null,
    request_body: reqBody,
    response_body: respBody,
    response_headers: respHeaders,
  });
}

main().catch((e) => {
  emit({ ok: false, error: `unhandled: ${e?.stack || e?.message || String(e)}` });
  process.exit(1);
});
