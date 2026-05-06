import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { messages, system } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY ?? "";
    if (!apiKey) {
      return NextResponse.json({ text: "⚠️ GEMINI_API_KEY is not set in Vercel environment variables." });
    }

    // Gemini uses "user" / "model" roles — never two of the same role in a row
    // Also first message must be "user"
    const geminiMessages: { role: string; parts: { text: string }[] }[] = [];
    for (const m of messages) {
      const role = m.role === "assistant" ? "model" : "user";
      // Skip consecutive same roles (Gemini rejects them)
      if (geminiMessages.length > 0 && geminiMessages[geminiMessages.length - 1].role === role) continue;
      geminiMessages.push({ role, parts: [{ text: m.content }] });
    }

    // Must start with user role
    if (geminiMessages.length === 0 || geminiMessages[0].role !== "user") {
      return NextResponse.json({ text: "Please send a message first." });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: geminiMessages,
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini error:", JSON.stringify(data));
      // Return the actual Gemini error message to help debug
      const geminiMsg = data?.error?.message ?? "Unknown Gemini error";
      return NextResponse.json({ text: `AI error: ${geminiMsg}` });
    }

    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text ??
      data.candidates?.[0]?.finishReason ??
      "No response generated.";

    return NextResponse.json({ text });

  } catch (err: any) {
    console.error("Route error:", err);
    return NextResponse.json({ text: `Server error: ${err?.message ?? "unknown"}` });
  }
}