import uuid
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
import aiosqlite
from app.database import get_db
from app.models import UserLogin, UserCreate, LoginResponse, UserResponse
from app.auth import verify_password, get_password_hash, create_access_token, require_auth, require_admin, TokenData

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_response(row) -> UserResponse:
    return UserResponse(
        id=row["id"],
        username=row["username"],
        first_name=row["first_name"] or "",
        last_name=row["last_name"] or "",
        title=row["title"] or "",
        role=row["role"]
    )


@router.post("/login", response_model=LoginResponse)
async def login(data: UserLogin, db: aiosqlite.Connection = Depends(get_db)):
    cursor = await db.execute(
        "SELECT id, username, first_name, last_name, title, password_hash, role FROM users WHERE username = ?",
        (data.username,)
    )
    row = await cursor.fetchone()
    if not row or not verify_password(data.password, row["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )

    token = create_access_token({
        "sub": row["id"],
        "username": row["username"],
        "first_name": row["first_name"] or "",
        "last_name": row["last_name"] or "",
        "title": row["title"] or "",
        "role": row["role"]
    })

    return LoginResponse(token=token, user=_user_response(row))


@router.get("/me", response_model=UserResponse)
async def get_me(db: aiosqlite.Connection = Depends(get_db), user: TokenData = Depends(require_auth)):
    cursor = await db.execute(
        "SELECT id, username, first_name, last_name, title, role FROM users WHERE id = ?",
        (user.user_id,)
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return _user_response(row)


@router.get("/users", response_model=List[UserResponse])
async def list_users(db: aiosqlite.Connection = Depends(get_db), _: TokenData = Depends(require_admin)):
    cursor = await db.execute(
        "SELECT id, username, first_name, last_name, title, role FROM users ORDER BY created_at ASC"
    )
    rows = await cursor.fetchall()
    return [_user_response(r) for r in rows]


@router.post("/users", response_model=UserResponse)
async def create_user(data: UserCreate, db: aiosqlite.Connection = Depends(get_db), _: TokenData = Depends(require_admin)):
    username = data.username.strip()
    first_name = data.first_name.strip()
    if not username or not first_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username and first name are required")
    if len(data.password or "") < 4:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 4 characters")
    if data.role not in ("staff", "night", "admin"):
        raise HTTPException(status_code=400, detail="Role must be staff, night, or admin")

    cursor = await db.execute("SELECT id FROM users WHERE username = ?", (username,))
    if await cursor.fetchone():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username already exists")

    user_id = f"usr_{uuid.uuid4().hex[:8]}"
    pwd_hash = get_password_hash(data.password)

    await db.execute(
        "INSERT INTO users (id, username, first_name, last_name, title, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user_id, username, first_name, data.last_name or "", data.title or "", pwd_hash, data.role or "staff")
    )
    await db.commit()

    cursor = await db.execute(
        "SELECT id, username, first_name, last_name, title, role FROM users WHERE id = ?", (user_id,)
    )
    row = await cursor.fetchone()
    return _user_response(row)


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, db: aiosqlite.Connection = Depends(get_db), current_user: TokenData = Depends(require_admin)):
    if user_id == current_user.user_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot delete your own account")

    cursor = await db.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not await cursor.fetchone():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    await db.commit()
    return {"success": True, "id": user_id}
