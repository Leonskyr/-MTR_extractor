const express = require('express');
const multer  = require('multer');
const fetch   = require('node-fetch');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));

// Поля которые должны быть заполнены — и их человекочитаемые названия
const REQUIRED_FIELDS = {
  unit:    'Единица измерения',
  name:    'Наименование МТР',
  brand:   'Марка/Размер',
  article: 'Каталожный номер',
  gost:    'ГОСТ/ТУ',
  spec:    'Техническая характеристика',
  symbol:  'Условное обозначение'
};

const PROMPT = `Ты — точный экстрактор данных из технических каталогов МТР для корпоративного справочника.

Из прикреплённого документа извлеки ВСЕ позиции товаров и материалов.

Верни ТОЛЬКО JSON-массив объектов. Никакого текста вокруг, никаких markdown-блоков, никаких пояснений.

Каждый объект должен содержать строго эти поля. Заполняй максимально возможно из того что есть в документе. Если данных нет — пустая строка "":
{
  "unit":    "базовая единица измерения. Для штучных товаров — ШТ. Если не указано явно — угадай по смыслу (уплотнения = ШТ, жидкости = Л, кабели = М и т.д.)",
  "name":    "полное техническое наименование. Если в документе есть общее название раздела (например 'Грязесъемная манжета сменная') — используй его как базу и добавь конкретику",
  "brand":   "марка, модель, тип, типоразмер. Например: тип уплотнения REG, AN, H, K, SHU",
  "article": "каталожный номер или артикул производителя — точно как в документе",
  "gost":    "ГОСТ, ТУ, НТД — только номер стандарта. Если не указан — пустая строка",
  "spec":    "ВСЕ технические характеристики через точку с запятой: внутренний диаметр, наружный диаметр, ширина, толщина, давление, температура, материал и т.д. — всё что есть в документе для данной позиции",
  "symbol":  "условное обозначение или аббревиатура. Если не указано — пустая строка"
}

Важные правила:
1. Извлекай КАЖДУЮ строку таблицы как отдельную позицию
2. Если данные берутся из заголовка группы (например внутренний диаметр указан для группы позиций) — включай их в spec каждой позиции группы
3. Все значения точно из документа, не придумывай
4. Поля class и comment НЕ заполнять — их заполнит пользователь`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Анализирует строки и возвращает список незаполненных полей
function analyzeCompleteness(rows) {
  const missingFields = new Set();
  const fieldMissingCount = {};

  Object.keys(REQUIRED_FIELDS).forEach(f => { fieldMissingCount[f] = 0; });

  rows.forEach(row => {
    Object.keys(REQUIRED_FIELDS).forEach(f => {
      if (!row[f] || row[f].trim() === '') {
        fieldMissingCount[f]++;
        missingFields.add(f);
      }
    });
  });

  // Формируем предупреждения только для полей где >30% строк пустые
  const warnings = [];
  Object.keys(REQUIRED_FIELDS).forEach(f => {
    const pct = Math.round((fieldMissingCount[f] / rows.length) * 100);
    if (pct > 30) {
      warnings.push(`«${REQUIRED_FIELDS[f]}» (не заполнено в ${pct}% позиций)`);
    }
  });

  return warnings;
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

async function processPdfInChunks(apiKey, b64, totalSize) {
  const allRows = [];

  if (totalSize <= 2 * 1024 * 1024) {
    const contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
    return await callClaude(apiKey, contentBlock);
  }

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

    // Анализируем полноту заполнения
    const warnings = rows.length > 0 ? analyzeCompleteness(rows) : [];
    const isPartial = warnings.length > 0;

    res.json({ rows, warnings, isPartial });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`МТР Экстрактор запущен на порту ${PORT}`));
