import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3210;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SYSTEM_PROMPT = `あなたはIndeedに掲載する求人票の作成を専門とする採用ライターです。
入力されたヒアリング内容をもとに、求職者の応募意欲を高める求人票を日本語で作成してください。

出力は以下のJSON形式のみで返してください。前置きや説明文は一切不要です。
{
  "title": "Indeedの検索結果に表示される求人タイトル(32文字以内目安、職種・給与・特徴を含める)",
  "body": "求人本文(見出しを使い、仕事内容・給与・勤務時間・応募資格・待遇・アピールポイントを整理して記載。Markdownの見出し記法(##)を使ってよい)"
}`;

app.post('/api/generate', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません。.env を確認してください。' });
  }

  const { hearing } = req.body;
  if (!hearing || typeof hearing !== 'string' || !hearing.trim()) {
    return res.status(400).json({ error: 'ヒアリング内容が空です。' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `以下のヒアリング内容から求人票を作成してください。\n\n${hearing}` }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: `Claude API エラー: ${response.status} ${errText}` });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text ?? '';

    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      return res.status(502).json({ error: 'AIの出力をJSONとして解析できませんでした。', raw: text });
    }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: `サーバーエラー: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`indeed-job-gen running at http://localhost:${PORT}`);
});
