import { isBot as isbot } from "isbot";
import { isSdkAgent } from "./agent.ts";

// Bot marking (D-20, enrich-13 to enrich-18, enrich-27, enrich-28). One bit:
// a known bot user agent or a Cloudflare verified-bot category. No network,
// ASN or provenance guesses, and a missing or long user agent alone is not a
// bot. The list combines isbot's pattern with the AI crawlers below. A name
// inside a longer token still counts, so "gptbotmalicious" is a bot.

const AI_CRAWLER =
  /gptbot|chatgpt-user|oai-searchbot|claudebot|perplexitybot|google-extended|applebot-extended/i;

/**
 * Whether the event is a bot. `userAgent` is the event's `$raw_user_agent`
 * when present, else the request's header (enrich-17). `verifiedBotCategory`
 * is `request.cf.verifiedBotCategory`. posthog-node and posthog-ios user
 * agents are never bots (enrich-13). Pure.
 */
export function isBot(userAgent: string | null, verifiedBotCategory: string | null): boolean {
  // isbot reads posthog-node and posthog-ios as script clients, so this runs first.
  if (userAgent !== null && isSdkAgent(userAgent)) return false;
  if (verifiedBotCategory !== null && verifiedBotCategory !== "") return true;
  if (userAgent === null || userAgent === "") return false;
  return AI_CRAWLER.test(userAgent) || isbot(userAgent);
}
