import { fetch as undiciFetch } from "undici";

import { logger } from "../logger.js";
import type { TelegramTaskPhase } from "../web/db.js";

export type TelegramRouterIntentType = "supplement" | "queue" | "unclear";

export interface TelegramRouterDecision {
  intentType: TelegramRouterIntentType;
  confidence: number;
  reasonShort: string;
}

export interface TelegramRouterContext {
  currentTaskSummary: string;
  currentPhase: TelegramTaskPhase;
  recentUserMessages: string[];
  incomingMessages: string[];
}

const DEFAULT_ROUTER_MODEL = process.env.TELEGRAM_ROUTER_MODEL?.trim() || "gpt-5.4-mini";
const DEFAULT_ROUTER_TIMEOUT_MS = parseInt(
  process.env.TELEGRAM_ROUTER_TIMEOUT_MS?.trim() || "2500",
  10,
);
const ROUTER_FAILURE_THRESHOLD = 3;
const ROUTER_CIRCUIT_OPEN_MS = 5 * 60_000;

function isTruthy(value?: string): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function buildHardRuleDecision(
  incomingMessages: string[],
): TelegramRouterDecision | null {
  const joined = incomingMessages.join("\n").trim();
  if (!joined) {
    return null;
  }

  if (/^\/(?:new|reset|start)\b/i.test(joined) || /(另开|排队|稍后再做|之后再做|新任务|另外一个)/u.test(joined)) {
    return {
      intentType: "queue",
      confidence: 1,
      reasonShort: "matched queue hard rule",
    };
  }

  if (
    /(补充|顺便|另外|再加|加一个|不是.+是.+|改成.+范围|简单说|表格|别贴路径|不要长路径)/u.test(joined)
  ) {
    return {
      intentType: "supplement",
      confidence: 0.96,
      reasonShort: "matched supplement hard rule",
    };
  }

  return null;
}

function normalizeDecision(payload: unknown): TelegramRouterDecision | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const intentType = typeof candidate.intentType === "string"
    ? candidate.intentType.trim()
    : "";
  if (intentType !== "supplement" && intentType !== "queue" && intentType !== "unclear") {
    return null;
  }

  const confidence = typeof candidate.confidence === "number"
    ? candidate.confidence
    : Number(candidate.confidence || 0);
  const reasonShort = typeof candidate.reasonShort === "string"
    ? candidate.reasonShort.trim()
    : "";

  return {
    intentType,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reasonShort: reasonShort || "router returned no reason",
  };
}

export class TelegramRouterClient {
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;

  isEnabled(): boolean {
    return isTruthy(process.env.TELEGRAM_ROUTER_ENABLED)
      && Boolean(process.env.TELEGRAM_ROUTER_BASE_URL?.trim())
      && Boolean(process.env.TELEGRAM_ROUTER_API_KEY?.trim());
  }

  async classify(context: TelegramRouterContext): Promise<TelegramRouterDecision> {
    const hardRuleDecision = buildHardRuleDecision(context.incomingMessages);
    if (hardRuleDecision) {
      return hardRuleDecision;
    }

    if (!this.isEnabled()) {
      return {
        intentType: "unclear",
        confidence: 0,
        reasonShort: "router disabled",
      };
    }

    if (this.circuitOpenedAt > 0 && Date.now() - this.circuitOpenedAt < ROUTER_CIRCUIT_OPEN_MS) {
      return {
        intentType: "unclear",
        confidence: 0,
        reasonShort: "router circuit open",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_ROUTER_TIMEOUT_MS);

    try {
      const response = await undiciFetch(process.env.TELEGRAM_ROUTER_BASE_URL!.trim(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.TELEGRAM_ROUTER_API_KEY!.trim()}`,
        },
        body: JSON.stringify({
          model: DEFAULT_ROUTER_MODEL,
          response_format: { type: "json_object" },
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: [
                    "You are a Telegram task router.",
                    "Classify whether the incoming messages should supplement the current task, queue as a new task, or remain unclear.",
                    "Return strict JSON with intentType, confidence, and reasonShort only.",
                  ].join("\n"),
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify(context),
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      const payload = await response.json() as Record<string, unknown>;
      const outputText =
        Array.isArray(payload.output)
          ? (payload.output[0] as Record<string, unknown> | undefined)?.content
          : undefined;
      let candidateText = "";
      if (Array.isArray(outputText)) {
        const first = outputText[0] as Record<string, unknown> | undefined;
        candidateText = typeof first?.text === "string" ? first.text : "";
      }
      if (!candidateText && typeof payload.output_text === "string") {
        candidateText = payload.output_text;
      }

      const parsed = normalizeDecision(candidateText ? JSON.parse(candidateText) : payload);
      if (!parsed) {
        throw new Error("router returned invalid payload");
      }

      this.consecutiveFailures = 0;
      this.circuitOpenedAt = 0;
      return parsed;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= ROUTER_FAILURE_THRESHOLD) {
        this.circuitOpenedAt = Date.now();
      }
      logger.warn("telegram.router.classify_failed", {
        failures: this.consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        intentType: "unclear",
        confidence: 0,
        reasonShort: "router failed",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
