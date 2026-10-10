import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.js";
import { AGENT_TOOLS } from "./tools.js";
import { DEFAULT_MODEL, type InfraIds } from "./types.js";

/** Bump when SYSTEM_PROMPT or AGENT_TOOLS change so existing agents get updated. */
export const AGENT_CONFIG_VERSION = 1;

const AGENT_NAME = "AI New Tab homepage builder";

function agentConfig() {
  return {
    name: AGENT_NAME,
    model: DEFAULT_MODEL,
    system: SYSTEM_PROMPT,
    tools: AGENT_TOOLS,
  };
}

/**
 * Create the environment + agent once per API key, or bring an existing agent
 * up to the current config. Sessions pick the model per build via overrides.
 */
export async function ensureInfra(client: Anthropic, existing: InfraIds | null): Promise<InfraIds> {
  if (existing) {
    try {
      if (existing.configVersion !== AGENT_CONFIG_VERSION) {
        await client.beta.agents.update(existing.agentId, agentConfig());
      }
      await client.beta.environments.retrieve(existing.environmentId);
      return { ...existing, configVersion: AGENT_CONFIG_VERSION };
    } catch (err) {
      // Agent or environment was archived/deleted (or belongs to another key): recreate.
      if (!(err instanceof Anthropic.NotFoundError) && !(err instanceof Anthropic.BadRequestError)) throw err;
    }
  }

  const environment = await client.beta.environments.create({
    name: "ai-newtab",
    // The agent only reads mounted files and writes one; it needs no outbound network.
    config: { type: "cloud", networking: { type: "limited" } },
  });
  const agent = await client.beta.agents.create(agentConfig());
  return { agentId: agent.id, environmentId: environment.id, configVersion: AGENT_CONFIG_VERSION };
}
