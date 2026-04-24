const express = require('express');
const multer  = require('multer');
const fetch   = require('node-fetch');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));

const PROMPT = `Ты — точный экстрактор данных из технических каталогов МТР (материально-технические ресурсы) для корпоративного справочника.

Из прикреплённого документа извлеки ВСЕ позиции товаров и материалов.

Верни ТОЛЬКО JSON-массив объектов. Никакого текста вокруг, никаких markdown-блоков, никаких пояснений.

Каждый объект должен содержать строго эти поля (если данных нет — пустая строка ""):
{
  "unit":    "базовая единица измерения (ШТ, КГ, М, М2, М3, УП, КОМ, ЛИТ и т.д.)",
  "name":    "полное техническое наименование МТР",
  "brand":   "марка, модель, типоразмер",
  "article": "каталожный номер или артикул производителя",
  "gost":    "ГОСТ, ТУ, НТД — только номер стандарта",
  "spec":    "технические характеристики подробно: напряжение, ток, мощность, материал, габариты, давление, температура и т.д.",
  "symbol":  "условное обозначение или аббревиатура"
}

Поля class и comment НЕ заполнять — их заполнит пользователь вручную.
Если поля нет в документе — пустая строка "". Все значения точно из документа, не придумывай.`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callClaude(apiKey, contentBlock) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-5',
      max_tokens: 4000,
      messages:   [{ role: 'user', content: [contentBlock, { type: 'text', text: PROMPT }] }]
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API: HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const text = (data.content || []).map(c => c.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const match = clean.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    return [];
  }
}

// Разбивка большого PDF на страницы по ~1МБ
async function processPdfInChunks(apiKey, b64, totalSize) {
  const allRows = [];

  if (totalSize <= 2 * 1024 * 1024) {
    const contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
    return await callClaude(apiKey, contentBlock);
  }

  // Разбиваем base64 на чанки по ~1.2МБ
  const CHUNK = 1200 * 1024;
  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK) {
    chunks.push(b64.slice(i, i + CHUNK));
  }

  for (let i = 0; i < chunks.length; i++) {
    const contentBlock = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: chunks[i] }
    };

    try {
      const rows = await callClaude(apiKey, contentBlock);
      allRows.push(...rows);
    } catch (e) {
      if (e.message.includes('rate') || e.message.includes('429')) {
        await sleep(30000);
        const rows = await callClaude(apiKey, contentBlock);
        allRows.push(...rows);
      } else {
        console.error(`Чанк ${i+1} пропущен:`, e.message);
      }
    }

    if (i < chunks.length - 1) await sleep(6000);
  }

  return allRows;
}

app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API-ключ не настроен на сервере' });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    const fileBuffer = req.file.buffer;
    const mimeType   = req.file.mimetype;
    const b64        = fileBuffer.toString('base64');
    const isPdf      = mimeType === 'application/pdf';

    let rows;
    if (isPdf) {
      rows = await processPdfInChunks(apiKey, b64, fileBuffer.length);
    } else {
      const contentBlock = { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } };
      rows = await callClaude(apiKey, contentBlock);
    }

    res.json({ rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`МТР Экстрактор запущен на порту ${PORT}`));
