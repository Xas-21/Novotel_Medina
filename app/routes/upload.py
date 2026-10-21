import os
import uuid
import logging
from io import BytesIO
from PIL import Image, ImageOps
from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
import aiosqlite
from app.database import get_db, UPLOADS_DIR
from app.auth import require_auth, TokenData

router = APIRouter(prefix="/api/upload", tags=["upload"])
logger = logging.getLogger("novotel.upload")

MAX_UPLOAD_BYTES = 12 * 1024 * 1024

@router.post("")
async def upload_photo(
    file: UploadFile = File(...),
    db: aiosqlite.Connection = Depends(get_db),
    _user: TokenData = Depends(require_auth),
):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file uploaded")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Photo must be 12 MB or smaller")
    try:
        img = Image.open(BytesIO(contents))
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        if img.width > 1600 or img.height > 1600:
            img.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        file_id = f"img_{uuid.uuid4().hex[:12]}"
        filename = f"{file_id}.jpg"
        out_path = os.path.join(UPLOADS_DIR, filename)
        img.save(out_path, format="JPEG", quality=82, optimize=True)
        size_bytes = os.path.getsize(out_path)
    except Exception:
        logger.error("Image processing failed")
        raise HTTPException(status_code=400, detail="Upload a photo")

    file_url = f"/api/uploads/{filename}"
    await db.execute(
        "INSERT INTO uploads (id, filename, original_name, url, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)",
        (file_id, filename, file.filename, file_url, "image/jpeg", size_bytes),
    )
    await db.commit()
    return {"success": True, "id": file_id, "url": file_url, "filename": filename, "size": size_bytes}
