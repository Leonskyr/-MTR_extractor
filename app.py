"""
МТР Экстрактор — Flask-сервер
PDF/JPEG/PNG → Claude API (native vision) → JSON позиций МТР
"""
from __future__ import annotations

import base64
import json
import os
import re
import tempfile

import anthropic
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__, static_folder="public")

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

Из прикреплённого документа извлеки ВСЕ позиции товаров и материалов.

Верни ТОЛЬКО JSON-массив объектов. Никакого текста вокруг, никаких markdown-блоков, никаких пояснений.

Каждый объект должен содержать строго эти поля (если данных нет — пустая строка ""):
{
  "unit":    "единица измерения. Для штучных товаров — ШТ. Угадай по смыслу если не указано",
  "name":    "полное наименование товара. Используй название раздела/категории как основу",
  "brand":   "тип, марка, модель — например REG, AN, H, K, SHU или другое обозначение",
  "article": "каталожный номер точно как в документе",
  "gost":    "ГОСТ или ТУ если есть, иначе пустая строка",
  "spec":    "ВСЕ технические параметры через точку с запятой. Если таблица содержит строки-заголовки групп — включай этот параметр в spec каждой позиции группы",
  "symbol":  "условное обозначение если есть, иначе пустая строка"
}

Правила:
1. Каждая строка данных = отдельный объект в массиве
2. Строки-заголовки групп — НЕ отдельные позиции, а параметры для позиций ниже
3. Все значения точно из документа, не придумывай
4. Поля class и comment НЕ заполнять — их заполнит пользователь вручную"""


# ── Claude (native document/vision API) ───────────────────────────────────────

def extract_with_claude(file_path: str, ext: str, api_key: str) -> list[dict]:
    """Отправляет файл напрямую в Claude API (PDF или изображение)."""
    client = anthropic.Anthropic(api_key=api_key)

    with open(file_path, "rb") as f:
        data = base64.standard_b64encode(f.read()).decode("utf-8")

    if ext == "pdf":
        file_block: dict = {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": data},
        }
    elif ext == "png":
        file_block = {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": data},
        }
    else:  # jpg / jpeg
        file_block = {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": data},
        }

    message = client.messages.create(
        model="claude-opus-4-7",
        max_tokens=16000,
        messages=[{
            "role": "user",
            "content": [file_block, {"type": "text", "text": PROMPT}],
        }],
    )

    if message.stop_reason == "max_tokens":
        raise RuntimeError(
            "Ответ модели был обрезан (слишком много позиций). "
            "Попробуйте разбить каталог на несколько файлов."
        )

    return _parse_response(message.content[0].text)


def _parse_response(raw: str) -> list[dict]:
    clean = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        parsed = json.loads(clean)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict):
            return [parsed]
    except json.JSONDecodeError:
        match = re.search(r"\[[\s\S]*\]", clean)
        if match:
            try:
                return json.loads(match.group())
            except Exception:
                pass
    return []


# ── Анализ полноты ─────────────────────────────────────────────────────────

def analyze_completeness(rows: list[dict]) -> list[str]:
    if not rows:
        return []
    warnings = []
    for field, label in REQUIRED_FIELDS.items():
        empty = sum(1 for r in rows if not str(r.get(field, "")).strip())
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

    if ext not in ("pdf", "jpg", "jpeg", "png"):
        return jsonify({"error": f"Формат .{ext} не поддерживается"}), 400

    tmp_dir = tempfile.mkdtemp()
    tmp_path = os.path.join(tmp_dir, filename)
    file.save(tmp_path)

    try:
        rows = extract_with_claude(tmp_path, ext, api_key)
        warnings = analyze_completeness(rows)

        return jsonify({
            "rows": rows,
            "warnings": warnings,
            "isPartial": len(warnings) > 0,
            "ocr_warning": None,
            "total": len(rows),
        })

    except anthropic.BadRequestError as e:
        return jsonify({"error": f"Файл не поддерживается Claude API: {e}"}), 422
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 422
    except Exception as e:
        return jsonify({"error": f"Внутренняя ошибка: {e}"}), 500
    finally:
        try:
            os.remove(tmp_path)
            os.rmdir(tmp_dir)
        except OSError:
            pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    app.run(host="0.0.0.0", port=port)
