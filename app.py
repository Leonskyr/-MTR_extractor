"""
МТР Экстрактор — Flask-сервер
PDF/JPEG → Markdown (docling или Tesseract OCR) → Claude → Excel-данные
"""
from __future__ import annotations

import os
import json
import tempfile
import anthropic
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__, static_folder="public")

# ── Константы ──────────────────────────────────────────────────────────────
SCAN_THRESHOLD = 50   # если docling вернул меньше символов — считаем скан
MAX_CHUNK_CHARS = 12_000  # максимум символов в одном запросе к Claude

REQUIRED_FIELDS = {
    "unit":    "Единица измерения",
    "name":    "Наименование МТР",
    "brand":   "Марка/Размер",
    "article": "Каталожный номер",
    "gost":    "ГОСТ/ТУ",
    "spec":    "Техническая характеристика",
    "symbol":  "Условное обозначение",
}

PROMPT = """Ты — точный экстрактор данных из технических каталогов МТР для корпоративного справочника.

Из прикреплённого текста (конвертированного из каталога) извлеки ВСЕ позиции товаров и материалов.

Верни ТОЛЬКО JSON-массив объектов. Никакого текста вокруг, никаких markdown-блоков, никаких пояснений.

Каждый объект должен содержать строго эти поля (если данных нет — пустая строка ""):
{
  "unit":    "единица измерения. Для штучных товаров — ШТ. Угадай по смыслу если не указано",
  "name":    "полное наименование товара. Используй название раздела/категории как основу",
  "brand":   "тип, марка, модель — например REG, AN, H, K, SHU или другое обозначение",
  "article": "каталожный номер точно как в документе",
  "gost":    "ГОСТ или ТУ если есть, иначе пустая строка",
  "spec":    "ВСЕ технические параметры через точку с запятой. Если таблица содержит строки-заголовки групп (например 'Внутренний диаметр - 1,50 дюйма') — включай этот параметр в spec каждой позиции группы",
  "symbol":  "условное обозначение если есть, иначе пустая строка"
}

Правила:
1. Каждая строка данных = отдельный объект в массиве
2. Строки-заголовки групп — НЕ отдельные позиции, а параметры для позиций ниже
3. Все значения точно из текста, не придумывай
4. Поля class и comment НЕ заполнять — их заполнит пользователь вручную

Текст каталога:
"""


# ── Конвертация в Markdown ─────────────────────────────────────────────────

def pdf_to_markdown(path: str) -> tuple[str, str | None]:
    """PDF → Markdown через docling, фолбэк на Tesseract для сканов."""
    # Пробуем docling
    try:
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.datamodel.base_models import InputFormat

        opts = PdfPipelineOptions()
        opts.do_ocr = False
        opts.images_scale = 1.0

        converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
        )
        result = converter.convert(path)
        text = result.document.export_to_markdown()

        # Если текста мало — скан, запускаем OCR
        if len(text.replace(" ", "").replace("\n", "")) < SCAN_THRESHOLD:
            return _tesseract_pdf(path)

        return text, None

    except ImportError:
        # docling не установлен — пробуем OCR
        return _tesseract_pdf(path)
    except MemoryError:
        raise RuntimeError("Недостаточно памяти. Попробуйте файл меньшего размера.")
    except Exception as e:
        raise RuntimeError(f"Ошибка конвертации PDF: {e}")


def _tesseract_pdf(path: str) -> tuple[str, str | None]:
    """PDF → изображения → Tesseract OCR → Markdown."""
    try:
        import pytesseract
        from pdf2image import convert_from_path
        from PIL import Image

        pages = convert_from_path(path, dpi=200)
        lines = []
        for i, page in enumerate(pages):
            text = pytesseract.image_to_string(page, lang="rus+eng")
            lines.append(f"## Страница {i+1}\n\n{text}")

        return "\n\n".join(lines), "Файл распознан через Tesseract OCR."

    except Exception as e:
        raise RuntimeError(f"Ошибка OCR: {e}")


def image_to_markdown(path: str) -> tuple[str, str | None]:
    """JPEG/PNG → Tesseract OCR → текст."""
    try:
        import pytesseract
        from PIL import Image

        img = Image.open(path)
        text = pytesseract.image_to_string(img, lang="rus+eng")
        return text, "Изображение распознано через Tesseract OCR."

    except Exception as e:
        raise RuntimeError(f"Ошибка OCR изображения: {e}")


# ── Claude ─────────────────────────────────────────────────────────────────

def extract_with_claude(text: str, api_key: str) -> list[dict]:
    """Отправляет текст в Claude, получает список позиций МТР."""
    client = anthropic.Anthropic(api_key=api_key)
    all_rows = []

    # Разбиваем на чанки если текст большой
    chunks = _split_text(text, MAX_CHUNK_CHARS)

    for chunk in chunks:
        message = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=4000,
            messages=[{"role": "user", "content": PROMPT + chunk}]
        )
        raw = message.content[0].text.strip()
        clean = raw.replace("```json", "").replace("```", "").strip()

        try:
            parsed = json.loads(clean)
            if isinstance(parsed, list):
                all_rows.extend(parsed)
            elif isinstance(parsed, dict):
                all_rows.append(parsed)
        except json.JSONDecodeError:
            # Пробуем найти массив в тексте
            import re
            match = re.search(r'\[[\s\S]*\]', clean)
            if match:
                try:
                    all_rows.extend(json.loads(match.group()))
                except Exception:
                    pass

    return all_rows


def _split_text(text: str, chunk_size: int) -> list[str]:
    """Разбивает текст на чанки по абзацам."""
    if len(text) <= chunk_size:
        return [text]

    chunks = []
    paragraphs = text.split("\n\n")
    current = []
    current_len = 0

    for para in paragraphs:
        if current_len + len(para) > chunk_size and current:
            chunks.append("\n\n".join(current))
            current = [para]
            current_len = len(para)
        else:
            current.append(para)
            current_len += len(para)

    if current:
        chunks.append("\n\n".join(current))

    return chunks


# ── Анализ полноты ─────────────────────────────────────────────────────────

def analyze_completeness(rows: list[dict]) -> list[str]:
    """Возвращает список полей где >30% строк пустые."""
    if not rows:
        return []

    warnings = []
    for field, label in REQUIRED_FIELDS.items():
        empty = sum(1 for r in rows if not r.get(field, "").strip())
        pct = round(empty / len(rows) * 100)
        if pct > 30:
            warnings.append(f"«{label}» (не заполнено в {pct}% позиций)")

    return warnings


# ── Маршруты ───────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory("public", "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory("public", filename)


@app.route("/api/extract", methods=["POST"])
def extract():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return jsonify({"error": "API-ключ не настроен на сервере"}), 500

    if "file" not in request.files:
        return jsonify({"error": "Файл не получен"}), 400

    file = request.files["file"]
    filename = file.filename or "upload"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    # Сохраняем во временный файл
    tmp_dir = tempfile.mkdtemp()
    tmp_path = os.path.join(tmp_dir, filename)
    file.save(tmp_path)

    try:
        # Конвертируем в текст
        if ext == "pdf":
            md_text, ocr_warning = pdf_to_markdown(tmp_path)
        elif ext in ("jpg", "jpeg", "png"):
            md_text, ocr_warning = image_to_markdown(tmp_path)
        else:
            return jsonify({"error": f"Формат .{ext} не поддерживается"}), 400

        if not md_text.strip():
            return jsonify({"error": "Не удалось извлечь текст из файла"}), 422

        # Извлекаем позиции через Claude
        rows = extract_with_claude(md_text, api_key)

        # Анализируем полноту
        warnings = analyze_completeness(rows)
        is_partial = len(warnings) > 0

        return jsonify({
            "rows": rows,
            "warnings": warnings,
            "isPartial": is_partial,
            "ocr_warning": ocr_warning,
            "total": len(rows),
        })

    except RuntimeError as e:
        return jsonify({"error": str(e)}), 422
    except Exception as e:
        return jsonify({"error": f"Внутренняя ошибка: {e}"}), 500
    finally:
        # Удаляем временный файл
        try:
            os.remove(tmp_path)
            os.rmdir(tmp_dir)
        except OSError:
            pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    app.run(host="0.0.0.0", port=port)
