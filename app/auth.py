import os
import time
import bcrypt
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from pydantic import BaseModel
import aiosqlite
from app.database import get_db

SECRET_KEY = os.getenv("SECRET_KEY", "novotel-secret-key-2026-dmr-super-secure")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_SECONDS = 3600 * 24 * 30  # 30 days

security = HTTPBearer(auto_error=False)

class TokenData(BaseModel):
    user_id: str
    username: str
    first_name: str
    last_name: str
    title: str
    role: str

    @property
    def full_name(self) -> str:
        name = f"{self.first_name} {self.last_name}".strip()
        return name or self.username

def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))
    except Exception:
        return False

def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

def create_access_token(data: dict, expires_delta: Optional[int] = None) -> str:
    to_encode = data.copy()
    expire = time.time() + (expires_delta or ACCESS_TOKEN_EXPIRE_SECONDS)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: aiosqlite.Connection = Depends(get_db)
) -> Optional[TokenData]:
    if not credentials:
        return None
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        username: str = payload.get("username")
        first_name: str = payload.get("first_name", "")
        last_name: str = payload.get("last_name", "")
        title: str = payload.get("title", "")
        role: str = payload.get("role", "staff")
        if user_id is None or username is None:
            return None
        return TokenData(
            user_id=user_id,
            username=username,
            first_name=first_name,
            last_name=last_name,
            title=title,
            role=role
        )
    except JWTError:
        return None

async def require_auth(user: Optional[TokenData] = Depends(get_current_user)) -> TokenData:
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user

async def require_admin(user: TokenData = Depends(require_auth)) -> TokenData:
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user

def can_write(role: str, section: str) -> bool:
    if role == "admin" or role == "staff":
        return section in ("duty", "night")
    if role == "night":
        return section == "night"
    return False
