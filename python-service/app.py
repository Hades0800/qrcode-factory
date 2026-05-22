"""上鎧鋼鐵 — Python Flask 服務

跟原本的 Node 後端（/backend）並存，預留給 Python 端要做的整合用
（例如報表匯出、PDF 產生、機器學習分析等）。

本地啟動：
    cd python-service
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env  # 視需要編輯
    python app.py
"""
import os
from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app, supports_credentials=True)


@app.get("/health")
def health():
    """供前端 / monitoring 用的健康檢查"""
    return jsonify(ok=True, service="python-flask", version="0.1.0")


@app.get("/api/hello")
def hello():
    """範例 endpoint — 之後改成實際業務"""
    name = request.args.get("name", "world")
    return jsonify(message=f"Hello, {name}!")


@app.errorhandler(404)
def not_found(_):
    return jsonify(error="Not found"), 404


@app.errorhandler(500)
def server_error(e):
    app.logger.exception(e)
    return jsonify(error="Internal server error"), 500


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
