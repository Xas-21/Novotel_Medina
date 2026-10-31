import uuid
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
import aiosqlite
from app.database import get_db
from app.models import UserLogin, UserCreate, LoginResponse, UserResponse, UserContactUpdate, UserPasswordReset
from app.auth import verify_password, get_password_hash, create_access_token, require_auth, require_admin, TokenData
from app.ws import ws_manager

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_response(row) -> UserResponse:
    keys = row.keys()
    return UserResponse(
        id=row["id"],
        username=row["username"],
        first_name=row["first_name"] or "",
        last_name=row["last_name"] or "",
        title=row["title"] or "",
        role=row["role"],
        email=(row["email"] or "") if "email" in keys else "",
        phone=(row["phone"] or "") if "phone" in keys else "",
    )


def _email_ok(value: str) -> bool:
    if not value:
        return True
    name, _, domain = value.partition("@")
    return bool(name and domain and "." in domain and " " not in value)


@router.post("/login", response_model=LoginResponse)
async def login(data: UserLogin, db: aiosqlite.Connection = Depends(get_db)):
    cursor = await db.execute(
        "SELECT id, username, first_name, last_name, title, password_hash, role, email, phone, session_version FROM users WHERE username = ?",
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
        "role": row["role"],
        "sv": int(row["session_version"] or 0),
    })

    return LoginResponse(token=token, user=_user_response(row))


@router.get("/me", response_model=UserResponse)
async def get_me(db: aiosqlite.Connection = Depends(get_db), user: TokenData = Depends(require_auth)):
    cursor = await db.execute(
        "SELECT id, username, first_name, last_name, title, role, email, phone FROM users WHERE id = ?",
        (user.user_id,)
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return _user_response(row)


@router.post("/logout")
async def logout(user: TokenData = Depends(require_auth), db: aiosqlite.Connection = Depends(get_db)):
    await db.execute(
        "UPDATE users SET session_version = COALESCE(session_version, 0) + 1 WHERE id = ?",
        (user.user_id,),
    )
    await db.commit()
    return {"success": True}


@router.get("/users", response_model=List[UserResponse])
async def list_users(db: aiosqlite.Connection = Depends(get_db), _: TokenData = Depends(require_admin)):
    cursor = await db.execute(
        "SELECT id, username, first_name, last_name, title, role, email, phone FROM users ORDER BY created_at ASC"
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
    if data.role not in ("staff", "night", "guest", "parking", "security", "admin"):
        raise HTTPException(status_code=400, detail="Role must be staff, night, guest, parking, security, or admin")

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
        "SELECT id, username, first_name, last_name, title, role, email, phone FROM users WHERE id = ?", (user_id,)
    )
    row = await cursor.fetchone()
    return _user_response(row)


@router.patch("/users/{user_id}", response_model=UserResponse)
async def update_user_contact(user_id: str, data: UserContactUpdate, db: aiosqlite.Connection = Depends(get_db), _: TokenData = Depends(require_admin)):
    email = (data.email or "").strip()
    phone = (data.phone or "").strip()
    if not _email_ok(email):
        raise HTTPException(status_code=400, detail="Enter a valid email")
    if len(phone) > 30:
        raise HTTPException(status_code=400, detail="Phone number is too long")
    cursor = await db.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not await cursor.fetchone():
        raise HTTPException(status_code=404, detail="User not found")
    await db.execute("UPDATE users SET email = ?, phone = ? WHERE id = ?", (email, phone, user_id))
    await db.commit()
    cursor = await db.execute(
        "SELECT id, username, first_name, last_name, title, role, email, phone FROM users WHERE id = ?",
        (user_id,),
    )
    return _user_response(await cursor.fetchone())


@router.post("/users/{user_id}/password")
async def reset_user_password(user_id: str, data: UserPasswordReset, db: aiosqlite.Connection = Depends(get_db), _: TokenData = Depends(require_admin)):
    if data.password != data.confirm:
        raise HTTPException(status_code=400, detail="Passwords do not match")
    if len(data.password or "") < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
    cursor = await db.execute("SELECT id, username FROM users WHERE id = ?", (user_id,))
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    await db.execute(
        "UPDATE users SET password_hash = ?, session_version = COALESCE(session_version, 0) + 1 WHERE id = ?",
        (get_password_hash(data.password), user_id),
    )
    await db.commit()
    await ws_manager.broadcast({"event": "PASSWORD_CHANGED", "userId": user_id})
    return {"success": True, "id": user_id}


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
