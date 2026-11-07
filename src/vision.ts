const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name} en el entorno`);
  return value;
}

export async function analyzePhoto<T>(bytes: Buffer, mime: string, name: string, systemPrompt: string, userPrompt: string, schema: object): Promise<T> {
  const imageMime = mime.split(";", 1)[0].toLowerCase();
  if (!IMAGE_TYPES.has(imageMime)) throw new Error(`Tipo de imagen no admitido: ${imageMime}`);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("La imagen está vacía o supera 10 MB");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${requiredEnv("OPENROUTER_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: requiredEnv("OPENROUTER_MODEL"),
      provider: { require_parameters: true },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: `data:${imageMime};base64,${bytes.toString("base64")}` } },
        ] },
      ],
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`OpenRouter: HTTP ${response.status}: ${body.slice(0, 500)}`);
  const data = JSON.parse(body) as { choices?: Array<{ finish_reason?: string; message?: { content?: string; refusal?: string } }> };
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`El modelo rechazó la imagen: ${choice.message.refusal}`);
  if (choice?.finish_reason !== "stop") throw new Error(`El modelo no completó el análisis: ${choice?.finish_reason ?? "sin estado"}`);
  const output = choice.message?.content;
  if (!output) throw new Error("OpenRouter no devolvió una lectura de la imagen");
  return JSON.parse(output) as T;
}
