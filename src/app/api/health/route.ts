import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    openai: Boolean(process.env.OPENAI_API_KEY),
    image: Boolean(process.env.OPENAI_API_KEY),
    stock: true,
    render: Boolean(process.env.CREATOMATE_API_KEY),
    timestamp: new Date().toISOString(),
  });
}
