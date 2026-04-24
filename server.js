const express = require('express');
const multer  = require('multer');
const fetch   = require('node-fetch');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } }); // 50 МБ макс.

// Статические файлы (index.html, xlsx.js и т.д.)
app.use(express.static(path.join(__dirname, 'public')));

// Основной эндпоинт — принимает файл и отдаёт извлечённые позиции
app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API-ключ не настроен на сервере' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Файл не получен' });
    }

    const fileBuffer = req.file.buffer;
    const mimeType   = req.file.mimetype;
    const b64        = fileBuffer.toString('base64');

    // Определяем тип блока для Claude
    const isPdf = mimeType === 'application/pdf';
    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mimeType,           data: b64 } };

    const prompt = `Ты — точный экстрактор данных из технических каталогов МТР (материально-технические ресурсы) для корпоративного справочника.

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

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages:   [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
      })
    });

    if (!anthropicResp.ok) {
      const err = await anthropicResp.json().catch(() => ({}));
      return res.status(502).json({ error: err.error?.message || `Anthropic API: HTTP ${anthropicResp.status}` });
    }

    const data = await anthropicResp.json();
    const text = (data.content || []).map(c => c.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      const match = clean.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]);
      else return res.status(502).json({ error: 'Не удалось разобрать ответ AI. Проверьте содержимое файла.' });
    }

    const rows = Array.isArray(parsed) ? parsed : [parsed];
    res.json({ rows });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`МТР Экстрактор запущен на порту ${PORT}`));
