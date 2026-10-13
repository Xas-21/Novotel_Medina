import os
import uuid
import logging
from io import BytesIO
from PIL import Image, ImageOps
from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
import aiosqlite
from app.database import get_db, UPLOADS_DIR
from app.auth import get_current_user

router = APIRouter(prefix="/api/upload", tags=["upload"])
logger = logging.getLogger("novotel.upload")

@router.post("")
async def upload_photo(
    file: UploadFile = File(...),
    db: aiosqlite.Connection = Depends(get_db)
):
    try:
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Empty file uploaded")
        
        # Process and optimize image
        try:
            img = Image.open(BytesIO(contents))
            # Auto-orient based on EXIF
            img = ImageOps.exif_transpose(img)
            
            # Convert RGBA / P to RGB
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            
            # Resize if very large (max 1600px width/height)
            max_size = 1600
            if img.width > max_size or img.height > max_size:
                img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
            
            file_id = f"img_{uuid.uuid4().hex[:12]}"
            filename = f"{file_id}.jpg"
            out_path = os.path.join(UPLOADS_DIR, filename)
            
            img.save(out_path, format="JPEG", quality=82, optimize=True)
            size_bytes = os.path.getsize(out_path)
            
        except Exception as e:
            logger.error(f"Image processing failed: {e}")
            # Fallback raw write
            file_id = f"img_{uuid.uuid4().hex[:12]}"
            filename = f"{file_id}_{file.filename}"
            out_path = os.path.join(UPLOADS_DIR, filename)
            with open(out_path, "wb") as f:
                f.write(contents)
            size_bytes = len(contents)
        
        file_url = f"/api/uploads/{filename}"
        
        await db.execute(
            "INSERT INTO uploads (id, filename, original_name, url, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)",
            (file_id, filename, file.filename, file_url, "image/jpeg", size_bytes)
        )
        await db.commit()
        
        return {
            "success": True,
            "id": file_id,
            "url": file_url,
            "filename": filename,
            "size": size_bytes
        }
        
    except Exception as e:
        logger.error(f"Upload error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to upload photo: {str(e)}")
