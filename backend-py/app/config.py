import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"
JWT_EXPIRES_DAYS = 7

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")
ADMIN_NAME = os.getenv("ADMIN_NAME", "管理員")

PORT = int(os.getenv("PORT", "8080"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "info").lower()

ALLOWED_ORIGINS = [
    "https://hades0800.github.io",
    "http://localhost:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
]

ALLOWED_MACHINES = {"No1-350", "No2-250", "No3-60", "No4-90", "No5-40", "No6-40"}

SOFT_DELETE_MODELS = {"Order", "Leader", "IdleEvent", "StepEntry", "PauseEvent"}
