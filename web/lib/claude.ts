import Anthropic from '@anthropic-ai/sdk';

/** Sends a single-turn prompt to Claude and returns the response text. */
export async function askClaude(prompt: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — add it to web/.env.local (get a key at https://console.anthropic.com/settings/keys)');
  }

  const client = new Anthropic();

  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 4096,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to answer this request.');
  }

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text response');
  }
  return textBlock.text;
}
