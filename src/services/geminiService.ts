// Text-to-speech goes through the server so the Gemini API key never reaches the browser.
export async function generateSpeech(text: string): Promise<string | null> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error(`TTS request failed: ${res.status}`);
  const data = await res.json();
  return data.audio || null;
}
