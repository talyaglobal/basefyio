/**
 * One switch for every feature that sends data to a hosted model: the
 * dashboard assistant, project agents, embeddings (platform and per-project),
 * SQL statement embedding, retrieval, recommendations and the marketing tools.
 *
 * `AI_ENABLED=false` turns them all off for installations that must not send
 * anything to OpenAI, Anthropic, Cohere, fal.ai, ElevenLabs or a remote
 * Ollama — an on-premises or air-gapped host, typically. Unset or any other
 * value keeps today's behaviour: each feature works when its own key is set.
 */
export function aiEnabled(): boolean {
  return (process.env.AI_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}

export const AI_DISABLED_MESSAGE = 'AI features are switched off on this installation (AI_ENABLED=false)';
